// Start the Google Drive consent flow.
//
// Reached by the OWNER'S BROWSER, from Kira's setup page — not by an operator, and not by a machine.
// That is the difference from the Xero equivalent, and it is why the tenant arrives as a signed
// claim rather than a query parameter: `/api/*` is outside the middleware matcher, so this route is
// publicly reachable, and a bare `?tenant=<uuid>` would let a stranger attach their own Google
// account to somebody else's business.
//
// @machine-callable — in the sense that it must never be gated by the session middleware. A redirect
// here would break the consent round trip.

import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';

import { serviceClient } from '@/lib/supabase';
import { verifyConnectToken } from '@/src/connect-token';
import { consentUrl, isDriveAccess, type DriveAccess } from '@/src/connectors/google';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const secret = process.env.ORCHESTRATOR_SECRET;
  if (!secret) {
    console.error('[connect/google] ORCHESTRATOR_SECRET unset — cannot verify the ticket.');
    return page('Google connection is not configured.', 503);
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return page(
      'Google Drive is not set up on this server yet. GOOGLE_CLIENT_ID and GOOGLE_REDIRECT_URI need to be configured.',
      503,
    );
  }

  const claim = verifyConnectToken(new URL(request.url).searchParams.get('t') ?? '', secret);
  if (!claim) {
    // Deliberately one message for expired, forged and malformed. The browser can do nothing
    // different with the distinction, and the distinction is useful only to someone probing.
    return page('That link has expired or is not valid. Start again from your Kira setup page.', 400);
  }

  const access: DriveAccess = isDriveAccess(claim.access) ? claim.access : 'readonly';

  // Single-use, server-side. Not a signed cookie: the callback must be able to prove this request
  // started here even if the browser dropped a cookie on the round trip through Google.
  const state = randomBytes(24).toString('hex');
  const { error } = await serviceClient().from('oauth_states').insert({
    state,
    tenant_id: claim.tenantId,
    provider: 'google',
    // What they chose, recorded BEFORE they leave. The callback compares this against what Google
    // actually granted — a consent screen lets a user untick scopes, and asking for Drive is not
    // the same as receiving it.
    metadata: { requested_access: access, expected_email: claim.email ?? null, return_to: claim.returnTo ?? null },
  });
  if (error) {
    console.error('[connect/google] could not record state:', error);
    return page('Could not start the connection. Please try again.', 500);
  }

  return NextResponse.redirect(
    consentUrl({ clientId, redirectUri, state, access, loginHint: claim.email }),
  );
}

function page(message: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<body style="font:16px/1.55 system-ui;max-width:34rem;margin:12vh auto;padding:0 1.25rem">` +
      `<h1 style="font-size:1.25rem">Connect Google Drive</h1><p>${message}</p></body>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}
