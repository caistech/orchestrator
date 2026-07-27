// Hourly: run the threshold sweep. The STA ingress — nothing happened, and that IS the trigger.
import { NextResponse } from 'next/server';
import { sweep } from '@/src/sweeper';
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
  const report = await sweep({ supabase: serviceClient(), tenantId: SEED_TENANT });
  console.log('[cron/sweep]', { candidates: report.candidates, emitted: report.emitted, held: report.held });
  return NextResponse.json(report);
}
