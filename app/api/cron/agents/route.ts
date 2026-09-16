// Every 10 minutes: run the agent worker. The async loop's heartbeat.
//
// Shares runAgentWorker with `npm run agents` (scripts/run-agents.ts) so the schedule and the
// shell can never drift — mirroring how the sweep route and scripts/sweep.ts share `sweep()`.
import { NextResponse } from 'next/server';
import { runAgentWorker } from '@/src/agents/worker';
import { serviceClient } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  // Fail closed — even a read-then-tag decision can eventually lead to mail.
  if (!secret) return NextResponse.json({ error: 'Cron not configured' }, { status: 503 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const report = await runAgentWorker({
    supabase: serviceClient(),
    apiKey: process.env.OPENAI_API_KEY ?? '',
    apply: true,
  });

  console.log('[cron/agents]', {
    processed: report.processed,
    runs: report.runs.length,
    stagedEvidence: report.stagedEvidence,
    evidenceErrors: report.evidenceErrors,
    ratchets: report.ratchets,
  });
  return NextResponse.json(report);
}