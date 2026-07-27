// The sweeper — one mechanism, twenty flows.
//
//   sweep canonical rows → past a threshold → CONFIRM → compose → gate → emit
//
// This is deliberately the whole of TASK_REGISTRY §6, and it is the first build for a reason worth
// restating: it exercises the task table, the state machine, the gate machinery and the review queue
// end to end, on real data, with ZERO model in the routing path. Every step is inspectable and
// deterministic, so when the agentic tiers arrive later they plug into something already proven
// rather than being debugged simultaneously with it.
//
// Idempotency is by intent_id, which is derived from (flow, entity, the day). Re-running the sweep
// within a day is therefore free — the insert conflicts and the row is left alone. That property is
// what makes it safe to run this on a schedule AND by hand while developing, which is exactly when
// a duplicate-chasing bug would otherwise be introduced.

import type { SupabaseClient } from '@supabase/supabase-js';
import { RULES, type SweepEntity, type SweepRule, type Threshold } from './rules.js';
import { resolveBand, type DelegationPolicy, type GateDecision } from './gate.js';
import { DevSourceConfirmer, confirmerFor, type SourceConfirmer } from './confirm.js';

export interface SweepOutcome {
  flow: string;
  entity: string;
  verdict: 'emitted' | 'held' | 'dropped_at_confirm' | 'unreachable' | 'duplicate';
  band?: string;
  detail?: string;
}

export interface SweepReport {
  candidates: number;
  emitted: number;
  held: number;
  droppedAtConfirm: number;
  unreachable: number;
  duplicates: number;
  outcomes: SweepOutcome[];
}

/** Deterministic per-day key: the same trigger on the same day is the same task. */
function intentIdFor(rule: SweepRule, entity: SweepEntity, today: string): string {
  return `sweep:${rule.flow}:${entity.id}:${today}`;
}

/**
 * Apply a rule's thresholds in the DATABASE, not in memory.
 *
 * Doing this in SQL is not an optimisation — a sweep that pulls every entity to filter in JS stops
 * working at the first tenant with a real ledger, and it would be discovered in production rather
 * than here.
 */
function applyThresholds(query: any, thresholds: Threshold[], nowIso: string) {
  for (const t of thresholds) {
    switch (t.kind) {
      case 'atLeast':
        query = query.gte(t.column, t.value);
        break;
      case 'below':
        query = query.lt(t.column, t.value);
        break;
      case 'olderThan':
        query = query.lt(t.column, subtract(nowIso, t.interval));
        break;
      case 'within':
        query = query.lte(t.column, addDate(nowIso, t.interval)).not(t.column, 'is', null);
        break;
      case 'jsonBelow':
        // No SQL filter: PostgREST cannot compare two JSON members to each other. Filtered below,
        // and narrowed by entity kind first so the set stays small. Called out rather than hidden,
        // because it is the one place this function does not do what its name promises.
        break;
    }
  }
  return query;
}

function subtract(nowIso: string, interval: string): string {
  const d = new Date(nowIso);
  const [n, unit] = interval.split(' ');
  const q = Number(n);
  if (unit.startsWith('day')) d.setUTCDate(d.getUTCDate() - q);
  else if (unit.startsWith('month')) d.setUTCMonth(d.getUTCMonth() - q);
  else if (unit.startsWith('hour')) d.setUTCHours(d.getUTCHours() - q);
  return d.toISOString();
}

function addDate(nowIso: string, interval: string): string {
  const d = new Date(nowIso);
  const [n, unit] = interval.split(' ');
  const q = Number(n);
  if (unit.startsWith('day')) d.setUTCDate(d.getUTCDate() + q);
  else if (unit.startsWith('month')) d.setUTCMonth(d.getUTCMonth() + q);
  return d.toISOString().slice(0, 10);
}

function jsonBelowHolds(rule: SweepRule, e: SweepEntity): boolean {
  const t = rule.thresholds.find((x) => x.kind === 'jsonBelow');
  if (!t || t.kind !== 'jsonBelow') return true;
  const a = Number(e.attributes?.[t.a]);
  const b = Number(e.attributes?.[t.b]);
  return Number.isFinite(a) && Number.isFinite(b) && a < b;
}

export interface SweepOptions {
  supabase: SupabaseClient;
  tenantId: string;
  /** Injected so tests and the seed's relative dates are reproducible. */
  now?: Date;
  confirmers?: Map<string, SourceConfirmer>;
  fallbackConfirmer?: SourceConfirmer;
  rules?: SweepRule[];
  /** When true, decide everything and write nothing. */
  dryRun?: boolean;
}

export async function sweep(opts: SweepOptions): Promise<SweepReport> {
  const { supabase, tenantId, dryRun = false } = opts;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);
  const rules = opts.rules ?? RULES;
  const confirmers = opts.confirmers ?? new Map<string, SourceConfirmer>();
  const fallback = opts.fallbackConfirmer ?? new DevSourceConfirmer();

  const { data: policyRow } = await supabase
    .from('delegation_policy')
    .select('bands, reserved')
    .eq('tenant_id', tenantId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  // No policy is not "no gating" — it is an unconfigured tenant, and the safe reading of silence is
  // to ask about everything rather than to authorise everything.
  const policy: DelegationPolicy = (policyRow as DelegationPolicy) ?? { bands: {}, reserved: [] };

  const report: SweepReport = {
    candidates: 0, emitted: 0, held: 0, droppedAtConfirm: 0, unreachable: 0, duplicates: 0, outcomes: [],
  };

  for (const rule of rules) {
    let q = supabase
      .from('entities')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('kind', rule.entityKind);
    q = applyThresholds(q, rule.thresholds, nowIso);

    const { data, error } = await q;
    if (error) throw new Error(`sweep(${rule.flow}) query failed: ${error.message}`);

    for (const row of (data ?? []) as SweepEntity[]) {
      if (!jsonBelowHolds(rule, row)) continue;
      report.candidates += 1;

      // ── DECISION: confirm against the source before anything is emitted ──────────────────────
      if (rule.confirmAtSource && row.mode === 'projected') {
        const confirmer = confirmerFor(row, confirmers, fallback);
        const result = await confirmer.confirm(row);
        if (!result.ok) {
          const verdict = result.unreachable ? 'unreachable' : 'dropped_at_confirm';
          if (result.unreachable) report.unreachable += 1;
          else report.droppedAtConfirm += 1;
          report.outcomes.push({ flow: rule.flow, entity: row.display_name, verdict, detail: result.reason });
          // Unreachable goes to the review queue as a failed task rather than vanishing; a stale
          // projection that the source contradicts is simply dropped, which is the correct outcome
          // and needs no human.
          if (!dryRun && result.unreachable) {
            await recordUnroutable(supabase, tenantId, rule, row, result.reason ?? 'source unreachable');
          }
          continue;
        }
      }

      // ── COMPOSE ─────────────────────────────────────────────────────────────────────────────
      const { summary, body } = rule.template(row);
      const spend = rule.spendAttribute ? Number(row.attributes?.[rule.spendAttribute] ?? 0) : null;

      // ── GATE ────────────────────────────────────────────────────────────────────────────────
      const decision: GateDecision = resolveBand(policy, { flow: rule.flow, action: rule.action, spend });

      if (dryRun) {
        report.outcomes.push({
          flow: rule.flow, entity: row.display_name,
          verdict: decision.holds ? 'held' : 'emitted',
          band: decision.band, detail: decision.why,
        });
        decision.holds ? (report.held += 1) : (report.emitted += 1);
        continue;
      }

      // ── EMIT ────────────────────────────────────────────────────────────────────────────────
      const intentId = intentIdFor(rule, row, today);
      const { data: task, error: taskErr } = await supabase
        .from('tasks')
        .insert({
          tenant_id: tenantId,
          intent_id: intentId,
          flow: rule.flow,
          ingress: 'STA',
          tier: 'M',
          status: decision.holds ? 'awaiting_approval' : 'queued',
          subject_entity_id: row.id,
          summary,
          payload: { action: rule.action, band: decision.band, why: decision.why, spend },
        })
        .select('id')
        .single();

      // A conflict is the idempotency key doing its job — this trigger already produced a task
      // today. Not an error, and specifically not a reason to send a second chase.
      if (taskErr) {
        if ((taskErr as { code?: string }).code === '23505') {
          report.duplicates += 1;
          report.outcomes.push({ flow: rule.flow, entity: row.display_name, verdict: 'duplicate' });
          continue;
        }
        throw new Error(`sweep(${rule.flow}) task insert failed: ${taskErr.message}`);
      }

      await supabase.from('drafts').insert({
        task_id: task.id,
        channel: 'email',
        subject: summary,
        body,
        recipients: row.email ? [row.email] : [],
      });

      await supabase.from('task_events').insert({
        task_id: task.id, event: 'routed',
        detail: { rule: rule.flow, band: decision.band, why: decision.why },
      });

      if (decision.holds) {
        await supabase.from('approvals').insert({ task_id: task.id });
        report.held += 1;
        report.outcomes.push({ flow: rule.flow, entity: row.display_name, verdict: 'held', band: decision.band, detail: decision.why });
      } else {
        // The outbox records the INTENDED change before it is attempted — this is the only reason
        // "did it actually send?" has an answer later.
        await supabase.from('effects').insert({
          task_id: task.id,
          kind: 'email.send',
          connector: 'resend',
          idempotency_key: intentId,
          // `commercial` travels ON THE EFFECT rather than being re-derived at send time. The
          // connector must not have to look up which rule produced a row to know whether the Spam
          // Act applies — that lookup is the kind that gets skipped during a refactor.
          request: { to: row.email, subject: summary, body, commercial: rule.commercial },
        });
        report.emitted += 1;
        report.outcomes.push({ flow: rule.flow, entity: row.display_name, verdict: 'emitted', band: decision.band, detail: decision.why });
      }
    }
  }

  return report;
}

async function recordUnroutable(
  supabase: SupabaseClient, tenantId: string, rule: SweepRule, entity: SweepEntity, reason: string,
) {
  await supabase.from('unroutable_requests').insert({
    tenant_id: tenantId,
    ingress: 'STA',
    raw: `${rule.flow} ${entity.display_name}`,
    reason,
  });
}
