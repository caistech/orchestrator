// Every 15 minutes: drain the outbox. Separated from the sweep on purpose — deciding and sending
// are different failure domains, and a mail outage must not stop the system noticing what is due.
import { NextResponse } from 'next/server';
import { drainEmailOutbox } from '@/src/connectors/email';
import { serviceClient, SEED_TENANT } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'Cron not configured' }, { status: 503 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'RESEND_API_KEY unset' }, { status: 503 });

  const report = await drainEmailOutbox({
    supabase: serviceClient(),
    tenantId: SEED_TENANT,
    apiKey,
    from: process.env.EMAIL_FROM,
    unsubscribeBaseUrl: process.env.UNSUBSCRIBE_BASE_URL,
    redirectTo: process.env.EMAIL_REDIRECT_TO,
  });
  console.log('[cron/drain]', { sent: report.sent, failed: report.failed, refused: report.refused });
  return NextResponse.json(report);
}
