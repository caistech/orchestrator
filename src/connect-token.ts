// A signed, short-lived ticket that lets Kira start a consent flow on an owner's behalf.
//
// The Xero connect route takes `?tenant=<uuid>` from the query string and trusts it. That is fine
// while the only caller is an operator behind the gate, and it is NOT fine for a route a customer's
// browser reaches: `/api/*` is excluded from the middleware matcher (it must be, or the redirect
// back from Google would be swallowed), so an unauthenticated stranger could otherwise start a
// consent flow naming somebody else's tenant and attach their own Google account to it.
//
// So the tenant is not a parameter, it is a CLAIM — minted by Kira, which has already authenticated
// the user, and signed with the secret the two systems already share. This side verifies rather than
// trusts.
//
// Short expiry because the ticket only has to survive a click: it is issued when the page renders
// and spent immediately. An hour is generous.

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ConnectClaim {
  tenantId: string;
  /** 'full' | 'readonly' | 'picked' — the owner's own choice, made in Kira's setup. */
  access: string;
  /**
   * 'none' | 'draft' | 'read' — how much of his mailbox, chosen by him alongside Drive.
   *
   * OPTIONAL, and absent means 'none'. Every ticket minted before this existed carries no value, and
   * the safe reading of silence about a mailbox is "do not ask for it" — an owner who never chose
   * Gmail must not be shown a consent screen requesting it because a field was missing.
   */
  gmail?: string | null;
  /** The Google address the owner said they use, passed to Google as a login hint. */
  email?: string | null;
  /** Where to send the browser once consent completes. */
  returnTo?: string | null;
  /** Unix seconds. */
  exp: number;
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (input: string): Buffer =>
  Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function signConnectToken(claim: ConnectClaim, secret: string): string {
  const payload = b64url(JSON.stringify(claim));
  const mac = b64url(createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${mac}`;
}

/**
 * Verify and decode, or null.
 *
 * Null for every failure — bad shape, bad signature, expired. The caller must not be able to tell
 * which, and there is nothing useful it could do differently anyway.
 */
export function verifyConnectToken(token: string, secret: string): ConnectClaim | null {
  const [payload, mac] = (token ?? '').split('.');
  if (!payload || !mac) return null;

  const expected = createHmac('sha256', secret).update(payload).digest();
  const actual = fromB64url(mac);
  // Length must match before timingSafeEqual, which throws on a mismatch rather than returning false.
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  try {
    const claim = JSON.parse(fromB64url(payload).toString('utf8')) as ConnectClaim;
    if (!claim?.tenantId || typeof claim.exp !== 'number') return null;
    if (claim.exp * 1000 < Date.now()) return null;
    return claim;
  } catch {
    return null;
  }
}
