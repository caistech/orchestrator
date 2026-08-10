// Who is calling, and which tenants may they act for?
//
// Until now every v1 route asked only the first half of that question — one shared
// ORCHESTRATOR_SECRET, checked fail-closed, and then the tenant taken from the request body. With a
// single trusted caller that is coherent: Kira only ever passes its own owner's id. It stops being
// coherent the moment there are two callers, and F2K-Checkpoint is worse than a second caller —
// it is ITSELF multi-tenant, so it legitimately presents many different tenant ids on one key.
// At that point "which tenant is this" is a claim, checked by nothing, and any holder of the secret
// can read or act as any business in the store.
//
// So the secret now identifies a CALLER, and the caller carries the tenants it may speak for.
//
// Deliberately env-driven rather than a table: onboarding a caller must not require a migration,
// and the credential must never sit in a row next to the data it protects.

import { ORCHESTRATOR_AUTH_HEADER } from './contract';

/** '*' means "any tenant" — see the note on legacy callers below. */
export interface Caller {
  id: string;
  tenants: '*' | string[];
}

export type AuthResult =
  | { ok: true; caller: Caller }
  | { ok: false; status: 400 | 401 | 403 | 503; error: string };

/**
 * Length-independent comparison, so a wrong secret does not leak its correctness one character at a
 * time. Length itself is not hidden; that is an accepted and standard limit of this shape.
 */
function secretsMatch(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i += 1) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

interface RegisteredCaller extends Caller {
  secret: string;
}

/**
 * The two variables this module reads — not the whole environment.
 *
 * `process.env` is assignable to this, so every caller passing nothing is unaffected. Naming the
 * two it actually touches lets a test hand over exactly those two without asserting its way past
 * the type: `NodeJS.ProcessEnv` requires NODE_ENV under Next's augmentation, so a partial literal
 * needed an `as` cast, and a cast is precisely the thing that would have hidden a real mismatch.
 */
export interface CallerEnv {
  ORCHESTRATOR_CALLERS?: string;
  ORCHESTRATOR_SECRET?: string;
  // Present so `process.env` — which carries an index signature — stays assignable. Without it the
  // two optional fields make this a "weak type", and TypeScript rejects the real environment for
  // having nothing provably in common with it.
  [key: string]: string | undefined;
}

/**
 * ORCHESTRATOR_CALLERS is a JSON array: [{ "id": "f2k", "secret": "…", "tenants": ["uuid", …] }].
 *
 * A malformed value THROWS rather than yielding an empty registry. An empty registry would refuse
 * every request, which looks like an outage and reads as safe — but the operator's next move is to
 * set the legacy secret and carry on, quietly reinstating the wildcard this exists to remove.
 */
export function parseCallers(env: CallerEnv = process.env): RegisteredCaller[] {
  const callers: RegisteredCaller[] = [];

  const raw = env.ORCHESTRATOR_CALLERS?.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('ORCHESTRATOR_CALLERS is not valid JSON — refusing to start with an unreadable caller registry.');
    }
    if (!Array.isArray(parsed)) {
      throw new Error('ORCHESTRATOR_CALLERS must be a JSON array of { id, secret, tenants }.');
    }
    for (const entry of parsed as Record<string, unknown>[]) {
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      const secret = typeof entry.secret === 'string' ? entry.secret : '';
      const tenants = entry.tenants;
      if (!id || !secret) {
        throw new Error('ORCHESTRATOR_CALLERS: every entry needs a non-empty id and secret.');
      }
      if (tenants !== '*' && !Array.isArray(tenants)) {
        throw new Error(`ORCHESTRATOR_CALLERS: caller "${id}" needs tenants: "*" or an array of tenant ids.`);
      }
      callers.push({
        id,
        secret,
        tenants: tenants === '*' ? '*' : (tenants as unknown[]).map(String),
      });
    }
  }

  // The legacy single secret stays valid, with wildcard scope, because Kira is live on it and its
  // tenants are its users — a set that cannot be enumerated in an env var today. Removing this
  // before Kira moves to a scoped key would take the running integration down, so it is kept
  // deliberately and named 'legacy' so it is visible in logs and in an audit.
  const legacy = env.ORCHESTRATOR_SECRET?.trim();
  if (legacy) {
    callers.push({ id: 'legacy', secret: legacy, tenants: '*' });
  }

  return callers;
}

/**
 * Authorise a request, and — for tenant-scoped endpoints — the tenant it claims to act for.
 *
 * `tenantId` is REQUIRED for anything that touches tenant data. Absent or blank is a 400, never an
 * implicit anything: the contract already states that rule for the list leg, and dispatch quietly
 * broke it by defaulting to a seed tenant, so a request with no tenant landed a real business's task
 * in a fixture.
 *
 * Pass `tenantId: null` ONLY for genuinely tenant-less endpoints.
 */
export function authoriseCaller(
  request: Request,
  tenantId: string | null | undefined,
  env: CallerEnv = process.env,
): AuthResult {
  let callers: RegisteredCaller[];
  try {
    callers = parseCallers(env);
  } catch (err) {
    console.error('[auth]', err instanceof Error ? err.message : err);
    return { ok: false, status: 503, error: 'Caller registry is misconfigured.' };
  }

  if (callers.length === 0) {
    console.error('[auth] no callers configured — refusing rather than running unauthenticated.');
    return { ok: false, status: 503, error: 'Orchestrator is not configured to accept callers.' };
  }

  const presented = request.headers.get(ORCHESTRATOR_AUTH_HEADER);
  if (!presented) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  const caller = callers.find((c) => secretsMatch(presented, c.secret));
  if (!caller) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  if (tenantId === null) {
    return { ok: true, caller: { id: caller.id, tenants: caller.tenants } };
  }

  const claimed = typeof tenantId === 'string' ? tenantId.trim() : '';
  if (!claimed) {
    return { ok: false, status: 400, error: 'tenantId is required.' };
  }

  if (caller.tenants !== '*' && !caller.tenants.includes(claimed)) {
    // Logged because a scoped caller reaching for another tenant is either a bug in that caller or
    // an attempt; either way it should be visible rather than a silent 403.
    console.error(`[auth] caller "${caller.id}" is not authorised for tenant ${claimed}`);
    return { ok: false, status: 403, error: 'Caller is not authorised for that tenant.' };
  }

  return { ok: true, caller: { id: caller.id, tenants: caller.tenants } };
}
