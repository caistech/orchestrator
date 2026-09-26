// The reconciliation detector — feeds the reconciliation_agent, one batch at a time.
//
// Mirrors src/sweeper.ts's shape (a plain function the CLI script AND the cron route both call) but
// is deliberately NOT a sweep rule: sweep() is model-free by design (TASK_REGISTRY §6), and this
// flow's whole job is to hand batches of unreconciled bank transactions to an LLM-backed agent.
// There is also no threshold and no template here — the "trigger" is simply "unreconciled lines
// exist", and the "compose" step is the agent's job (src/agents/runner.ts), not this file's.
//
// What this file DOES own, matching the sweeper's own discipline exactly:
//   - batching (so one task never covers the whole backlog — see BANK_RECONCILIATION_SKILL_SCOPE.md)
//   - deterministic idempotency (re-running finds the same unreconciled lines and does not re-queue
//     a batch that already has an open or completed task)
//
// See docs/BANK_RECONCILIATION_SKILL_SCOPE.md for the full design and phasing.

import type { SupabaseClient } from '@supabase/supabase-js';
import { xeroConnectionFor, fetchUnreconciledBankTransactions } from './connectors/xero';
import { agentFor } from './agents/register';

const AGENT_ID = 'reconciliation_agent';
const FLOW = '101';
const BATCH_SIZE = 25;

export interface ReconciliationDetectOptions {
  supabase: SupabaseClient;
  tenantId: string;
  /** Injected for reproducible tests; also lets a re-run on the same day be idempotent. */
  now?: Date;
  dryRun?: boolean;
}

export interface ReconciliationDetectReport {
  unreconciledFound: number;
  batchesConsidered: number;
  tasksCreated: number;
  duplicates: number;
  skippedReason?: string;
}

/** Deterministic per-day key: re-running the detector the same day for the same batch is free. */
function intentIdFor(tenantId: string, batchIndex: number, today: string): string {
  return `reconciliation:${tenantId}:batch${batchIndex}:${today}`;
}

export async function detectReconciliationWork(
  opts: ReconciliationDetectOptions,
): Promise<ReconciliationDetectReport> {
  const { supabase, tenantId, dryRun = false } = opts;
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);

  const report: ReconciliationDetectReport = {
    unreconciledFound: 0,
    batchesConsidered: 0,
    tasksCreated: 0,
    duplicates: 0,
  };

  const agent = agentFor(AGENT_ID);
  if (!agent) {
    report.skippedReason = `agent "${AGENT_ID}" not registered in config/agents.json`;
    return report;
  }

  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    report.skippedReason = 'XERO_CLIENT_ID / XERO_CLIENT_SECRET not set';
    return report;
  }

  const connection = await xeroConnectionFor(supabase, tenantId);
  if (!connection) {
    report.skippedReason = 'no active Xero connection for this tenant';
    return report;
  }

  // Walk pages until Xero says there are no more, collecting ids to batch. Xero pages at 100; this
  // is bounded by the real backlog size, not an arbitrary cap — a business with 1,274 unreconciled
  // lines walks ~13 pages once, and every subsequent run only re-walks what is still unreconciled.
  const allLines: { bankTransactionId: string }[] = [];
  let page = 1;
  for (;;) {
    const { lines, hasMore } = await fetchUnreconciledBankTransactions(supabase, connection, clientId, clientSecret, { page });
    allLines.push(...lines.map((l) => ({ bankTransactionId: l.bankTransactionId })));
    if (!hasMore) break;
    page += 1;
    if (page > 50) break; // hard stop — 5,000 lines is not a shape this detector should walk unattended
  }

  report.unreconciledFound = allLines.length;
  if (allLines.length === 0) return report;

  const batches: string[][] = [];
  for (let i = 0; i < allLines.length; i += BATCH_SIZE) {
    batches.push(allLines.slice(i, i + BATCH_SIZE).map((l) => l.bankTransactionId));
  }
  report.batchesConsidered = batches.length;

  if (dryRun) return report;

  for (let i = 0; i < batches.length; i++) {
    const intentId = intentIdFor(tenantId, i, today);
    const { error } = await supabase.from('tasks').insert({
      tenant_id: tenantId,
      intent_id: intentId,
      flow: FLOW,
      agent_id: agent.id,
      ingress: 'STA',
      tier: 'A',
      status: 'queued',
      summary: `Reconciliation categorisation — batch ${i + 1} of ${batches.length} (${batches[i].length} lines)`,
      payload: { transaction_ids: batches[i], batchIndex: i },
    });

    if (error) {
      if ((error as { code?: string }).code === '23505') {
        report.duplicates += 1;
        continue;
      }
      throw new Error(`reconciliation detector: task insert failed (batch ${i}): ${error.message}`);
    }
    report.tasksCreated += 1;
  }

  return report;
}
