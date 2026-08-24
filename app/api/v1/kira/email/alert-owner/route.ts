// POST /v1/kira/email/alert-owner — resolve owner name/email for unanswered-request alert enrichment.
//
// WHY THIS EXISTS. The alert email sent to operators includes the owner's name/email for context.
// This lookup uses the service-role client to read the `users` table (cross-tenant, privileged).
// Moving it here keeps Kira unprivileged.
//
// THE CAPABILITY. `kira-webhook` — called from unauthenticated public endpoints and signed webhooks
// in Kira. callerIs() enforces the boundary.
//
// SEMANTICS PRESERVED (verbatim from lib/email/unanswered-request.ts):
//   - Input: userId (UUID string)
//   - Output: resolved string like "Name (email@x.com)" or just "email@x.com"
//   - Fail-soft: any error (missing user, DB down) returns null rather than throwing — the alert
//     still goes out, just without enrichment.
//   - Query: SELECT email, first_name, last_name FROM users WHERE id = userId
//
// @machine-callable

import { NextResponse } from 'next/server';

import { kiraClient } from '@/lib/kira-supabase';
import { CONTRACT_VERSION } from '@/src/contract';
import { authoriseCaller, callerIs } from '@/src/caller-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isValidUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

async function resolveOwner(userId: string): Promise<{ owner: string | null }> {
  if (!isValidUUID(userId)) return { owner: null };

  const supabase = kiraClient();
  const { data, error } = await supabase
    .from('users')
    .select('email, first_name, last_name')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data) return { owner: null };

  const name = [data.first_name, data.last_name].filter(Boolean).join(' ');
  const owner = name ? `${name} (${data.email})` : data.email;
  return { owner };
}

export async function POST(request: Request) {
  const auth = authoriseCaller(request, null);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!callerIs(auth, 'kira-webhook')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { userId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 });
  }

  try {
    const result = await resolveOwner(userId);
    return NextResponse.json({ version: CONTRACT_VERSION, ...result });
  } catch (error) {
    console.error('[kira/email/alert-owner] resolve failed:', error);
    const message = error instanceof Error ? error.message : String(error);
    const unconfigured = message.includes('KIRA_SUPABASE');
    return NextResponse.json(
      { error: unconfigured ? 'Orchestrator is not configured for Kira data access.' : 'Owner resolve failed.' },
      { status: unconfigured ? 503 : 500 },
    );
  }
}