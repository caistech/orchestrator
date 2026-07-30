// Every 15 minutes: drain the outbox. Separated from the sweep on purpose — deciding and sending
// are different failure domains, and a mail outage must not stop the system noticing what is due.
//
// THIS USED TO SEND FOR ONE TENANT ONLY.
//
// `tenantId: SEED_TENANT` was hardcoded here, so the dev tenant's seeded traffic drained daily and
// no real customer's mail was ever sent — not because anything failed, but because the drain was
// never asked to look. STATE.md called that "a safeguard by construction, not by intent", and it was
// exactly right: it protected only because a constant pointed somewhere harmless. Four emails the
// owner had APPROVED BY VOICE on 28 July, including a $60,000 quote to a client, sat pending behind
// it for three days while every screen looked healthy.
//
// It now drains every tenant that actually has something pending, which makes two properties
// load-bearing:
//
//  1. PER-TENANT ISOLATION. drainEmailOutbox THROWS when a tenant has no sender identity — the right
//     call for one tenant, and fatal for a run across many, because a single un-onboarded business
//     would abort the batch and nobody else's mail would go either. Each tenant is drained inside
//     its own try/catch, so a failure stops at that tenant.
//  2. AN UNCONFIGURED TENANT IS A SKIP, NOT AN ERROR. A business part-way through onboarding is an
//     expected state, not an incident. It is reported as `skipped` with a reason so the count stays
//     visible, rather than logged as a failure that trains everyone to ignore the log.
//
// What still gates a send — so that un-pinning this changed nothing about WHAT may go out: an effect
// row only ever exists after an approval (the v1 approve route, or the queue action) or because the
// sweeper's router put the task in a notify band that needs none. This drain sends what was already
// decided. It decides nothing.

import { NextResponse } from 'next/server';
import { drainEmailOutbox, type DrainReport } from '@/src/connectors/email';
import { serviceClient } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Bounded per run: a backlog drains across runs rather than one invocation timing out mid-way. */
const TENANT_LIMIT = 50;

interface TenantOutcome {
  tenantId: string;
  outcome: 'drained' | 'skipped' | 'error';
  sent?: number;
  failed?: number;
  refused?: number;
  reason?: string;
}

/**
 * A missing sender identity is the one failure here that is routine rather than exceptional, so it
 * is matched on the connector's own message and reported as a skip. Matched narrowly on purpose:
 * anything else that throws is a real error and must not be quietly filed as "not onboarded yet".
 */
function isIdentityGap(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('tenant sender identity incomplete');
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'Cron not configured' }, { status: 503 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'RESEND_API_KEY unset' }, { status: 503 });

  const supabase = serviceClient();

  // Ask which tenants have something waiting rather than assuming. `effects` has no tenant column —
  // it hangs off tasks — so the join is the tenancy boundary here, exactly as it is inside the drain.
  const { data: pending, error } = await supabase
    .from('effects')
    .select('tasks!inner(tenant_id)')
    .eq('status', 'pending')
    .eq('kind', 'email.send');

  if (error) {
    console.error('[cron/drain] could not list pending tenants:', error);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  const tenantIds = [
    ...new Set(
      ((pending ?? []) as unknown as Array<{ tasks: { tenant_id: string } | null }>)
        .map((row) => row.tasks?.tenant_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const truncated = tenantIds.length > TENANT_LIMIT;
  const batch = tenantIds.slice(0, TENANT_LIMIT);

  const totals = { sent: 0, failed: 0, refused: 0, skipped: 0, errors: 0 };
  const tenants: TenantOutcome[] = [];

  for (const tenantId of batch) {
    try {
      const report: DrainReport = await drainEmailOutbox({
        supabase,
        tenantId,
        apiKey,
        from: process.env.EMAIL_FROM,
        unsubscribeBaseUrl: process.env.UNSUBSCRIBE_BASE_URL,
        redirectTo: process.env.EMAIL_REDIRECT_TO,
      });
      totals.sent += report.sent;
      totals.failed += report.failed;
      totals.refused += report.refused;
      tenants.push({ tenantId, outcome: 'drained', sent: report.sent, failed: report.failed, refused: report.refused });
    } catch (caught) {
      if (isIdentityGap(caught)) {
        totals.skipped += 1;
        tenants.push({
          tenantId,
          outcome: 'skipped',
          reason: 'no sender identity yet — the owner has not finished setting up their business',
        });
        continue;
      }
      // One tenant's problem stops at that tenant. Before this loop existed, it stopped everyone's.
      totals.errors += 1;
      console.error(`[cron/drain] ${tenantId} failed:`, caught);
      tenants.push({ tenantId, outcome: 'error', reason: caught instanceof Error ? caught.message : String(caught) });
    }
  }

  // Say what was left behind. A bound that truncates silently reads as "everything was covered".
  if (truncated) {
    console.warn(`[cron/drain] ${tenantIds.length} tenants pending, drained ${batch.length} — the rest go next run.`);
  }

  console.log('[cron/drain]', { tenantsPending: tenantIds.length, ...totals });
  return NextResponse.json({ tenantsPending: tenantIds.length, truncated, ...totals, tenants });
}
