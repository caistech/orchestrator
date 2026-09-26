// Daily: detect unreconciled Xero bank transactions and queue them for the reconciliation_agent, in
// batches. The STA ingress — nothing happened, and that IS the trigger, same shape as cron/sweep.
// Cadence is daily (vercel.json), not hourly like cron/sweep — this hits the Xero API for a full
// unreconciled-transactions walk (potentially dozens of pages), which is unnecessary load at an
// hourly cadence for a backlog that changes at most a few times a day. See
// docs/BANK_RECONCILIATION_SKILL_SCOPE.md §7 (Phasing) for the phase this belongs to.
//
// Deliberately its own route rather than folded into cron/sweep: this feeds a tier-A (agentic,
// model-backed) task, not a tier-M mechanical sweep rule, and mixing the two mechanisms in one route
// would blur exactly the distinction BANK_RECONCILIATION_SKILL_SCOPE.md draws between them.
//
// Tasks created here are picked up by the EXISTING cron/agents route (runAgentWorker) — no new
// execution machinery. This route only ever detects and queues; it never runs the agent itself.

import { NextResponse } from 'next/server';
import { detectReconciliationWork } from '@/src/reconciliation-detector';
import { serviceClient, SEED_TENANT } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  // Fail closed — this creates real tasks, and downstream a real (though read-only) OpenAI spend.
  if (!secret) return NextResponse.json({ error: 'Cron not configured' }, { status: 503 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // TODO before this runs against more than one tenant: iterate every tenant with a live Xero
  // connection, not just SEED_TENANT. Left single-tenant deliberately for Phase 1's one real test
  // case (Global Buildtech) — see BANK_RECONCILIATION_SKILL_SCOPE.md §"what Phase 1 does not do".
  const report = await detectReconciliationWork({ supabase: serviceClient(), tenantId: SEED_TENANT });

  console.log('[cron/reconciliation-detect]', report);
  return NextResponse.json(report);
}
