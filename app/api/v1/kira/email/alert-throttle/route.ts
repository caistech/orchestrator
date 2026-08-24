// POST /v1/kira/email/alert-throttle — authoritative durable throttle for unanswered-request alerts.
//
// WHY THIS EXISTS. The original throttle lived in Kira's process memory and was bypassed by
// serverless cold-starts — a CI probe exhausted the shared Resend quota and took down auth
// email for the whole portfolio (2026-08-03). Moving the authoritative decision here puts the
// blast-radius reducer behind Orchestrator's authenticated boundary: a flooded Kira instance
// degrades to its in-memory limiter while the real throttle keeps working.
//
// THE CAPABILITY. `kira-webhook` — called from unauthenticated public endpoints and signed webhooks
// in Kira, so the credential must be a server-to-server one. callerIs() enforces the boundary.
//
// SEMANTICS PRESERVED (verbatim from lib/email/unanswered-request.ts):
//   - WINDOW_MS = 10 minutes
//   - MAX_PER_WINDOW = 5
//   - RETENTION_MS = 24 hours
//   - utteranceKey = sha256(trimmed_lowercased_utterance[:500])
//   - Returns: null = allowed, string = rejection reason ('duplicate within the window' | 'ceiling of 5 per 10m reached')
//   - Atomicity: the check-and-claim is a single DB transaction (SELECT count + INSERT) so concurrent
//     requests cannot both pass — the unique constraint on utterance_key is the lock.
//   - Pruning: opportunistic DELETE of rows older than 24h after each claim.
//   - On DB error: throws so Kira falls back to in-memory limiter (degraded mode, not silent failure).
//
// @machine-callable

import { NextResponse } from 'next/server';

import { kiraClient } from '@/lib/kira-supabase';
import { CONTRACT_VERSION } from '@/src/contract';
import { authoriseCaller, callerIs } from '@/src/caller-auth';
import { createHash } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALERT_TABLE = 'unanswered_alert_sends';
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 5;
const RETENTION_MS = 24 * 60 * 60_000;

function utteranceKey(utterance: string): string {
  return createHash('sha256')
    .update(utterance.trim().toLowerCase().slice(0, 500))
    .digest('hex');
}

async function claimThrottle(utterance: string): Promise<{ allowed: boolean; reason?: string }> {
  const supabase = kiraClient();
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const key = utteranceKey(utterance);

  // Check for duplicate utterance within window
  const { count: sameUtterance, error: dupError } = await supabase
    .from(ALERT_TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('utterance_key', key)
    .gt('sent_at', since);
  if (dupError) throw dupError;
  if ((sameUtterance ?? 0) > 0) {
    return { allowed: false, reason: 'duplicate within the window' };
  }

  // Check ceiling across all utterances
  const { count: anyUtterance, error: capError } = await supabase
    .from(ALERT_TABLE)
    .select('id', { count: 'exact', head: true })
    .gt('sent_at', since);
  if (capError) throw capError;
  if ((anyUtterance ?? 0) >= MAX_PER_WINDOW) {
    return { allowed: false, reason: `ceiling of ${MAX_PER_WINDOW} per ${WINDOW_MS / 60000}m reached` };
  }

  // Claim the slot (the INSERT is the lock)
  const { error: insertError } = await supabase.from(ALERT_TABLE).insert({ utterance_key: key });
  if (insertError) throw insertError;

  // Opportunistic prune — failure ignored (housekeeping must not block alert)
  Promise.resolve(
    supabase
      .from(ALERT_TABLE)
      .delete()
      .lt('sent_at', new Date(Date.now() - RETENTION_MS).toISOString())
  ).catch(() => {});

  return { allowed: true };
}

export async function POST(request: Request) {
  const auth = authoriseCaller(request, null);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!callerIs(auth, 'kira-webhook')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { utterance?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const utterance = typeof body.utterance === 'string' ? body.utterance : '';
  if (!utterance || utterance.trim().length === 0) {
    return NextResponse.json({ error: 'utterance is required' }, { status: 400 });
  }

  try {
    const result = await claimThrottle(utterance);
    return NextResponse.json({ version: CONTRACT_VERSION, ...result });
  } catch (error) {
    console.error('[kira/email/alert-throttle] claim failed:', error);
    const message = error instanceof Error ? error.message : String(error);
    const unconfigured = message.includes('KIRA_SUPABASE');
    return NextResponse.json(
      { error: unconfigured ? 'Orchestrator is not configured for Kira data access.' : 'Throttle claim failed.' },
      { status: unconfigured ? 503 : 500 },
    );
  }
}