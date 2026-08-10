// Every 15 minutes: drain the outbox. Separated from the sweep on purpose — deciding and sending are
// different failure domains, and a mail outage must not stop the system noticing what is due.
//
// THIS USED TO KNOW ABOUT EXACTLY ONE EFFECT KIND.
//
// The query was `.eq('kind', 'email.send')` and the call was one function. `effects.kind` is open
// text and its own column comment lists `invoice.create | calendar.book | …` as intended values — so
// an effect of any other kind was accepted, stored, and never executed. No error, no retry, no
// alert: status stayed `pending` and every screen looked healthy. Adding a tool meant remembering to
// edit this file, and NOT remembering was silent.
//
// It now asks the TOOL REGISTER (config/tools.json) what it can execute, and — the part that matters
// more — it counts and names anything pending that the register does not cover. An unregistered kind
// is now loud. A check that quietly does nothing is indistinguishable from one that passed, which is
// how this repo lost four approved emails for three days and a month of deploys to silence.
//
// TWO PROPERTIES THAT REMAIN LOAD-BEARING, both learned the hard way:
//
//  1. PER-TENANT ISOLATION. An executor may throw for one tenant; before the per-tenant try/catch a
//     single un-onboarded business aborted the batch and nobody else's mail went either.
//  2. AN UNCONFIGURED TENANT IS A SKIP, NOT AN ERROR. A business part-way through onboarding is an
//     expected state. Reported with a reason so the count stays visible, rather than logged as a
//     failure that trains everyone to ignore the log.
//
// What still gates a send — so that generalising this changed nothing about WHAT may go out: an
// effect row only ever exists after an approval (the v1 approve route, or the queue action) or
// because the sweeper's router put the task in a notify band that needs none. This drain performs
// what was already decided. It decides nothing, and registering a tool does not change that.

import { NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabase';
import { executableKinds, toolFor } from '@/src/tools/register';
import { executorFor } from '@/src/tools/executors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Bounded per run: a backlog drains across runs rather than one invocation timing out mid-way. */
const TENANT_LIMIT = 50;

interface TenantOutcome {
  tenantId: string;
  kind: string;
  outcome: 'drained' | 'skipped' | 'error';
  sent?: number;
  failed?: number;
  refused?: number;
  fallbackFrom?: boolean;
  reason?: string;
}

interface PendingRow {
  kind: string;
  tasks: { tenant_id: string } | null;
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'Cron not configured' }, { status: 503 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = serviceClient();

  // Ask what is pending across ALL kinds, not just the ones we can run. Filtering in the query would
  // reproduce the original defect in a new place: the rows we cannot execute are exactly the rows
  // worth knowing about, and a query that never selects them can never report them.
  const { data: pending, error } = await supabase
    .from('effects')
    .select('kind, tasks!inner(tenant_id)')
    .eq('status', 'pending');

  if (error) {
    console.error('[cron/drain] could not list pending effects:', error);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  const rows = (pending ?? []) as unknown as PendingRow[];
  const runnable = new Set(executableKinds());

  // (kind → tenants) for what we can run, and a plain count for what we cannot.
  const work = new Map<string, Set<string>>();
  const unregistered = new Map<string, number>();

  for (const row of rows) {
    const tenantId = row.tasks?.tenant_id;
    if (!tenantId) continue;
    if (runnable.has(row.kind)) {
      const set = work.get(row.kind) ?? new Set<string>();
      set.add(tenantId);
      work.set(row.kind, set);
    } else {
      unregistered.set(row.kind, (unregistered.get(row.kind) ?? 0) + 1);
    }
  }

  // LOUD, not silent. This is the entire reason the register exists: a kind nothing can execute used
  // to be indistinguishable from no work at all.
  if (unregistered.size > 0) {
    for (const [kind, count] of unregistered) {
      console.error(
        `[cron/drain] ${count} pending effect(s) of kind "${kind}" — NOT in the tool register, so ` +
          `nothing will ever execute them. Register it in config/tools.json and bind an executor in ` +
          `src/tools/executors.ts.`,
      );
    }
  }

  const totals = { sent: 0, failed: 0, refused: 0, skipped: 0, errors: 0 };
  const tenants: TenantOutcome[] = [];
  let truncatedAny = false;

  for (const [kind, tenantSet] of work) {
    const executor = executorFor(kind);
    if (!executor) {
      // Registered as executable but nothing bound. `npm run check:tools` fails on this in CI, so
      // reaching it in production means the check was skipped — say so rather than passing silently.
      console.error(
        `[cron/drain] "${kind}" is class:effect in the register but has no executor bound. ` +
          `check:tools should have caught this before deploy.`,
      );
      totals.errors += 1;
      continue;
    }

    const ids = [...tenantSet];
    const batch = ids.slice(0, TENANT_LIMIT);
    if (ids.length > batch.length) {
      truncatedAny = true;
      // Say what was left behind. A bound that truncates silently reads as "everything was covered".
      console.warn(
        `[cron/drain] ${kind}: ${ids.length} tenants pending, draining ${batch.length} — the rest go next run.`,
      );
    }

    for (const tenantId of batch) {
      try {
        const result = await executor({ supabase, tenantId });

        if (result.skipped) {
          totals.skipped += 1;
          tenants.push({ tenantId, kind, outcome: 'skipped', reason: result.reason });
          continue;
        }

        totals.sent += result.sent;
        totals.failed += result.failed;
        totals.refused += result.refused;
        tenants.push({
          tenantId,
          kind,
          outcome: 'drained',
          sent: result.sent,
          failed: result.failed,
          refused: result.refused,
          // Surfaced per tenant rather than aggregated: "some mail went out on our domain" is not
          // actionable, "THIS tenant's did" is.
          ...(result.usedFallbackFrom && result.sent > 0 ? { fallbackFrom: true } : {}),
        });
      } catch (caught) {
        // One tenant's problem stops at that tenant. Before this existed, it stopped everyone's.
        totals.errors += 1;
        console.error(`[cron/drain] ${kind} ${tenantId} failed:`, caught);
        tenants.push({
          tenantId,
          kind,
          outcome: 'error',
          reason: caught instanceof Error ? caught.message : String(caught),
        });
      }
    }
  }

  const unregisteredReport = [...unregistered].map(([kind, pendingCount]) => ({ kind, pending: pendingCount }));

  console.log('[cron/drain]', {
    pendingEffects: rows.length,
    kindsRun: [...work.keys()],
    ...totals,
    ...(unregisteredReport.length ? { unregistered: unregisteredReport } : {}),
  });

  return NextResponse.json({
    pendingEffects: rows.length,
    kindsRun: [...work.keys()],
    truncated: truncatedAny,
    ...totals,
    // Always present when non-empty, at the top level, so it cannot be missed by anything reading
    // this response — including a human skimming the cron log.
    ...(unregisteredReport.length ? { unregistered: unregisteredReport } : {}),
    tenants,
  });
}
