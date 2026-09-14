// Hourly: run the threshold sweep. The STA ingress — nothing happened, and that IS the trigger.
import { NextResponse } from 'next/server';
import { sweep } from '@/src/sweeper';
import { cancelExpiredClarifyTasks } from '@/src/clarify';
import { serviceClient, SEED_TENANT } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  // Fail closed — this creates real tasks that lead to real mail.
  if (!secret) return NextResponse.json({ error: 'Cron not configured' }, { status: 503 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // T1 housekeeping: clarifying tasks whose 48h TTL lapsed stop looking alive. Bounded and
  // fail-soft — a blocked pass logs nothing new and the sweep still runs.
  const expiredClarify = await cancelExpiredClarifyTasks(serviceClient(), SEED_TENANT).catch((e) => {
    console.error('[cron/sweep] clarify housekeeping failed:', e);
    return 0;
  });
  const report = await sweep({ supabase: serviceClient(), tenantId: SEED_TENANT });
  console.log('[cron/sweep]', {
    candidates: report.candidates,
    emitted: report.emitted,
    held: report.held,
    expiredClarify,
  });
  return NextResponse.json({ ...report, expiredClarify });
}
