// POST /v1/kira/email/suppressions — Kira's suppression-table operations moved behind
// Orchestrator's authenticated boundary.
//
// WHY THIS EXISTS. The suppression list is a global, cross-tenant authority: one opt-out covers
// every product. Kira must not hold the service-role key that can read/write it. The remediation
// makes Kira an unprivileged caller: it proxies here with a scoped credential, and this side does
// the database work against Kira's own Supabase project (lib/kira-supabase.ts).
//
// THE CAPABILITY. `kira-webhook` is the appropriate identity: suppression mutations originate from
// server-to-server flows (webhook unsubscribes, cron sends, compliance tooling). A leaked admin
// secret must NOT reach this route; a leaked public secret must NOT either. callerIs() enforces this.
//
// SEMANTICS PRESERVED. @caistech/email-compliance's SuppressionStore interface demands:
//   - isSuppressed(email) → boolean
//   - suppress(email, reason, detail?) → void, idempotent
//   - resubscribe(email) → void
// All three map cleanly to the add/remove/check actions below. Email normalisation (lowercase/trim)
// lives in the shared package and is delegated to the store implementation here.
//
// @machine-callable

import { NextResponse } from 'next/server';

import { kiraClient } from '@/lib/kira-supabase';
import { CONTRACT_VERSION } from '@/src/contract';
import { authoriseCaller, callerIs } from '@/src/caller-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUPPRESSIONS_TABLE = 'email_suppressions';

type SuppressAction = 'add' | 'remove' | 'check';

interface SuppressRequest {
  action: SuppressAction;
  email: string;
  reason?: 'unsubscribe' | 'bounce' | 'complaint' | 'manual';
  detail?: string;
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function suppressAdd(email: string, reason: string, detail?: string): Promise<{ applied: boolean }> {
  const supabase = kiraClient();
  const { error } = await supabase
    .from(SUPPRESSIONS_TABLE)
    .upsert({ email, reason, detail, created_at: new Date().toISOString() }, { onConflict: 'email' });
  if (error) throw new Error(`suppression upsert failed: ${error.message}`);
  return { applied: true };
}

async function suppressRemove(email: string): Promise<{ applied: boolean }> {
  const supabase = kiraClient();
  const { error } = await supabase.from(SUPPRESSIONS_TABLE).delete().eq('email', email);
  if (error) throw new Error(`suppression delete failed: ${error.message}`);
  return { applied: true };
}

async function suppressCheck(email: string): Promise<{ isSuppressed: boolean }> {
  const supabase = kiraClient();
  const { data, error } = await supabase
    .from(SUPPRESSIONS_TABLE)
    .select('email')
    .eq('email', email)
    .maybeSingle();
  if (error) throw new Error(`suppression check failed: ${error.message}`);
  return { isSuppressed: !!data };
}

export async function POST(request: Request) {
  const auth = authoriseCaller(request, null);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!callerIs(auth, 'kira-webhook')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: SuppressRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  if (!['add', 'remove', 'check'].includes(body.action)) {
    return NextResponse.json({ error: 'action must be one of add, remove, check' }, { status: 400 });
  }

  const email = normaliseEmail(body.email ?? '');
  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'valid email is required' }, { status: 400 });
  }

  try {
    switch (body.action) {
      case 'add': {
        const reason = body.reason ?? 'unsubscribe';
        if (!['unsubscribe', 'bounce', 'complaint', 'manual'].includes(reason)) {
          return NextResponse.json({ error: 'invalid reason' }, { status: 400 });
        }
        const result = await suppressAdd(email, reason, body.detail);
        return NextResponse.json({ version: CONTRACT_VERSION, ...result });
      }
      case 'remove': {
        const result = await suppressRemove(email);
        return NextResponse.json({ version: CONTRACT_VERSION, ...result });
      }
      case 'check': {
        const result = await suppressCheck(email);
        return NextResponse.json({ version: CONTRACT_VERSION, ...result });
      }
    }
  } catch (error) {
    console.error('[kira/email/suppressions] action failed:', error);
    const message = error instanceof Error ? error.message : String(error);
    const unconfigured = message.includes('KIRA_SUPABASE');
    return NextResponse.json(
      { error: unconfigured ? 'Orchestrator is not configured for Kira data access.' : 'Suppression operation failed.' },
      { status: unconfigured ? 503 : 500 },
    );
  }
}