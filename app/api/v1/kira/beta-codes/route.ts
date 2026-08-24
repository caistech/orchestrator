// POST /v1/kira/beta-codes — the first Group B migration: Kira's service-role beta-code access,
// moved behind this service's authenticated boundary.
//
// WHY THIS EXISTS. Beta redemption runs PRE-authentication — the code creates the account, so no
// user session exists and RLS cannot authorise the work. Until now Kira reached for its
// service-role key to serve these routes. The remediation makes Kira an unprivileged caller: it
// proxies here with a scoped credential, and this side does the database work against Kira's own
// project (lib/kira-supabase.ts).
//
// THE CAPABILITY. `kira-public` is deliberately the narrowest caller identity: these are the only
// operations in the whole service that are safe to expose to a request carrying no user identity.
// A leaked webhook or admin secret must NOT be able to reach this route — that separation is what
// callerIs() enforces below, and why the actions live behind it rather than on an unauthenticated path.
//
// THE LOCK SURVIVES THE HOP. `claim` is one guarded UPDATE (`WHERE redeemed_at IS NULL`) executed
// entirely inside this function: two simultaneous redemptions still resolve to exactly one winner,
// because the atomicity lives in Postgres, not in the client. What the network adds is a failure
// mode the old direct call did not have — if THIS request dies after the update committed, the code
// is burnt but no account exists. That is precisely the situation `release` exists for, and Kira's
// signup flow already calls it there; the ordering and the escape hatch both carry over unchanged.
//
// @machine-callable

import { NextResponse } from 'next/server';

import { kiraClient } from '@/lib/kira-supabase';
import { CONTRACT_VERSION } from '@/src/contract';
import { authoriseCaller, callerIs } from '@/src/caller-auth';
import {
  checkBetaCode,
  normaliseBetaCode,
  type BetaCodeRejection,
  type BetaCodeRow,
} from '@/src/kira/beta-codes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PeekOrClaimResult =
  | { ok: true; email: string }
  | { ok: false; reason: BetaCodeRejection };

/** Look the code up without consuming it. Mirrors Kira's peekBetaCode. */
async function peek(code: string): Promise<PeekOrClaimResult> {
  const supabase = kiraClient();
  const { data, error } = await supabase
    .from('beta_codes')
    .select('code, email, expires_at, redeemed_at, revoked_at')
    .eq('code', code)
    .maybeSingle();

  if (error) throw new Error(`beta_codes read failed: ${error.message}`);

  // The distinction between rejections is logged HERE now rather than in Kira: an operator helping
  // a real tester on the phone greps THIS service's logs, because this is where the verdict is made.
  const rejection = checkBetaCode((data as BetaCodeRow | null) ?? null, new Date());
  if (rejection) {
    console.error(`[kira/beta-codes] peek rejected code ${code}: ${rejection}`);
    return { ok: false, reason: rejection };
  }
  return { ok: true, email: String((data as BetaCodeRow).email).toLowerCase() };
}

/**
 * Consume a code, atomically. Mirrors Kira's claimBetaCode.
 *
 * ⚠️ THE UPDATE IS THE LOCK (carried over verbatim): `WHERE redeemed_at IS NULL` plus a row-or-nothing
 * result is what makes a double-clicked button create one account. Claimed BEFORE the account is
 * created, so the failure mode is a burnt code rather than a code that can mint a second one.
 */
async function claim(code: string): Promise<PeekOrClaimResult> {
  const gate = await peek(code);
  if (!gate.ok) return gate;

  const supabase = kiraClient();
  const { data, error } = await supabase
    .from('beta_codes')
    .update({ redeemed_at: new Date().toISOString() })
    .eq('code', code)
    .is('redeemed_at', null)
    .select('code, email')
    .maybeSingle();

  if (error) throw new Error(`beta_codes claim failed: ${error.message}`);
  if (!data) {
    // Lost the race, or the row moved between the peek and the claim. Reported as already-redeemed
    // because that is what it is from here.
    return { ok: false, reason: 'redeemed' };
  }
  return { ok: true, email: String(data.email).toLowerCase() };
}

/** Attach the account to the code after the fact, for the operator's record. Never fails a request. */
async function link(code: string, userId: string): Promise<{ ok: true; applied: boolean }> {
  const supabase = kiraClient();
  const { error } = await supabase
    .from('beta_codes')
    .update({ redeemed_user_id: userId })
    .eq('code', code);

  if (error) {
    // Harmless, record-only — same swallow as Kira's original. But the wire answer stays honest:
    // applied:false says the operator's record was not written without turning a cosmetic miss into
    // a failed signup.
    console.error('[kira/beta-codes] could not link code to user (harmless, record only):', error);
    return { ok: true, applied: false };
  }
  return { ok: true, applied: true };
}

/**
 * Hand a claimed code back when redemption could not complete. Never fails a request.
 *
 * Called ONLY when no account was created (Kira's flow guarantees it), so it can never release a
 * code that already produced one — the `redeemed_user_id IS NULL` guard is the second half of that.
 */
async function release(code: string): Promise<{ ok: true; applied: boolean }> {
  const supabase = kiraClient();
  const { data, error } = await supabase
    .from('beta_codes')
    .update({ redeemed_at: null })
    .eq('code', code)
    .is('redeemed_user_id', null)
    .select('code');

  if (error) {
    console.error('[kira/beta-codes] could not release code after a failed redemption:', error);
    return { ok: true, applied: false };
  }
  return { ok: true, applied: Array.isArray(data) && data.length > 0 };
}

export async function POST(request: Request) {
  // Tenant-less BY DESIGN: a beta code predates any account, so there is no tenant to scope to.
  // Passing null is the explicit opt-in from authoriseCaller's contract, not an oversight.
  const auth = authoriseCaller(request, null);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!callerIs(auth, 'kira-public')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { action?: string; code?: unknown; userId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const action = typeof body.action === 'string' ? body.action : '';
  if (action !== 'peek' && action !== 'claim' && action !== 'link' && action !== 'release') {
    return NextResponse.json(
      { error: 'action must be one of peek, claim, link, release' },
      { status: 400 },
    );
  }

  const raw = typeof body.code === 'string' ? body.code : '';
  const code = normaliseBetaCode(raw);
  // An empty code after normalisation means the caller sent whitespace/punctuation only. Rejected
  // before touching the database: it can never match a row, and refusing early keeps the logs free
  // of junk that would drown the real signals.
  if (!code) return NextResponse.json({ error: 'code is required' }, { status: 400 });

  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  if (action === 'link') {
    if (!UUID.test(userId)) {
      return NextResponse.json({ error: 'userId must be a UUID for action=link' }, { status: 400 });
    }
  }
  if (action !== 'link' && userId) {
    return NextResponse.json({ error: 'userId is only accepted for action=link' }, { status: 400 });
  }

  try {
    switch (action) {
      case 'peek': {
        const result = await peek(code);
        return NextResponse.json({ version: CONTRACT_VERSION, ...result });
      }
      case 'claim': {
        const result = await claim(code);
        return NextResponse.json({ version: CONTRACT_VERSION, ...result });
      }
      case 'link':
        return NextResponse.json({ version: CONTRACT_VERSION, ...(await link(code, userId)) });
      case 'release':
        return NextResponse.json({ version: CONTRACT_VERSION, ...(await release(code)) });
    }
  } catch (error) {
    // Distinguish the two configuration failures callers actually need telling apart: this service
    // missing ITS env (deploy/config problem, retry may help) versus a database fault on Kira's
    // project (retry almost certainly will not). Both are 5xx; the message differs for the operator.
    console.error('[kira/beta-codes] action failed:', error);
    const message = error instanceof Error ? error.message : String(error);
    const unconfigured = message.includes('KIRA_SUPABASE');
    return NextResponse.json(
      { error: unconfigured ? 'Orchestrator is not configured for Kira data access.' : 'Beta-code operation failed.' },
      { status: unconfigured ? 503 : 500 },
    );
  }
}
