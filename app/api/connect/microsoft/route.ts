// Start the Microsoft OneDrive consent flow.
//
// The twin of app/api/connect/google/route.ts. Reached by the OWNER'S BROWSER, from Kira's setup
// page — not by an operator and not by a machine. That is why the tenant arrives as a signed claim
// rather than a query parameter: `/api/*` is outside the middleware matcher, so this route is
// publicly reachable, and a bare `?tenant=<uuid>` would let a stranger attach their own OneDrive to
// somebody else's business.
//
// The ticket format is SHARED with the Google flow deliberately — same `ConnectClaim`, same secret,
// same `access` field. Kira mints one kind of ticket and the provider is chosen by which URL it is
// sent to, so there is no second token shape to keep in step.
//
// @machine-callable — in the sense that it must never be gated by the session middleware. A redirect
// here would break the consent round trip.

import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';

import { serviceClient } from '@/lib/supabase';
import { verifyConnectToken } from '@/src/connect-token';
import { consentUrl, isFilesAccess, type FilesAccess } from '@/src/connectors/microsoft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `readwrite`, NOT `readonly` — the same load-bearing reasoning as the Google route's `picked`.
 *
 * `readonly` is the only tier that CANNOT WRITE, so an owner who took it could never have his
 * operating manual filed back into his own OneDrive, which is the point of the product. Fixing that
 * later means asking a cautious sixty-something for a second consent months after the first, which
 * is the kind of thing that simply does not happen.
 *
 * It is also the least privilege that can still do the job: `readwrite` is his own OneDrive and
 * nothing else, where `all` reaches colleagues' shared files and the company SharePoint.
 *
 * ⚠️ Unlike the Google route there is no least-privilege-AND-avoids-verification alignment to take
 * here, because Graph has no `drive.file` equivalent. See `FilesAccess` in src/connectors/microsoft.ts.
 *
 * Kept in step with the callback's own fallback — see app/api/connect/microsoft/callback/route.ts.
 */
const DEFAULT_FILES_ACCESS: FilesAccess = 'readwrite';

export async function GET(request: Request) {
  const secret = process.env.ORCHESTRATOR_SECRET;
  if (!secret) {
    console.error('[connect/microsoft] ORCHESTRATOR_SECRET unset — cannot verify the ticket.');
    return page('Microsoft connection is not configured.', 503);
  }

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return page(
      'OneDrive is not set up on this server yet. MICROSOFT_CLIENT_ID and MICROSOFT_REDIRECT_URI need to be configured.',
      503,
    );
  }

  const claim = verifyConnectToken(new URL(request.url).searchParams.get('t') ?? '', secret);
  if (!claim) {
    // Deliberately one message for expired, forged and malformed. The browser can do nothing
    // different with the distinction, and the distinction is useful only to someone probing.
    return page('That link has expired or is not valid. Start again from your Kira setup page.', 400);
  }

  // The shared ticket carries Google's vocabulary in `access`. An unrecognised value — including a
  // perfectly valid Google level like 'picked', which has no Microsoft equivalent — falls to the
  // default rather than being guessed at. Mapping 'picked' onto a whole-OneDrive grant would hand
  // him something wider than the word he chose.
  const access: FilesAccess = isFilesAccess(claim.access) ? claim.access : DEFAULT_FILES_ACCESS;

  // Single-use, server-side. Not a signed cookie: the callback must be able to prove this request
  // started here even if the browser dropped a cookie on the round trip through Microsoft.
  const state = randomBytes(24).toString('hex');
  const { error } = await serviceClient().from('oauth_states').insert({
    state,
    tenant_id: claim.tenantId,
    provider: 'microsoft',
    // What they chose, recorded BEFORE they leave. The callback compares this against what Microsoft
    // actually granted — asking for a scope is not the same as receiving it.
    metadata: {
      requested_access: access,
      expected_email: claim.email ?? null,
      return_to: claim.returnTo ?? null,
    },
  });
  if (error) {
    console.error('[connect/microsoft] could not record state:', error);
    return page('Could not start the connection. Please try again.', 500);
  }

  return NextResponse.redirect(consentUrl({ clientId, redirectUri, state, access, loginHint: claim.email }));
}

function page(message: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<body style="font:16px/1.55 system-ui;max-width:34rem;margin:12vh auto;padding:0 1.25rem">` +
      `<h1 style="font-size:1.25rem">Connect OneDrive</h1><p>${message}</p></body>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}
