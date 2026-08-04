// Google consent callback — exchange the code, record the connection, and say plainly what was
// actually granted.
//
// Two things are checked here that a naive callback skips, both because "connected" is a word that
// hides failure well:
//
//   1. WHICH SCOPES CAME BACK. Google's consent screen lets a user untick permissions. The response
//      carries what was really granted, so a request for full Drive that came back as nothing is
//      caught now rather than as an empty file list a week later.
//   2. WHICH ACCOUNT CONSENTED. Owners are routinely signed into several Google accounts. If they
//      connect a different one from the address they named at setup, the connection succeeds and the
//      Drive contains none of their work — a failure with no error anywhere. So the addresses are
//      compared and the mismatch is said out loud.
//
// @machine-callable — Google redirects a browser here; the middleware must not gate it.

import { NextResponse } from 'next/server';

import { serviceClient } from '@/lib/supabase';
import {
  connectedAccount,
  exchangeCode,
  grantedDriveAccess,
  isDriveAccess,
  type DriveAccess,
} from '@/src/connectors/google';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LABEL: Record<DriveAccess, string> = {
  full: 'full access (read and write)',
  readonly: 'read-only access',
  picked: 'access to files you pick',
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const denied = url.searchParams.get('error');

  if (denied) return page(`Google declined the connection: ${escapeHtml(denied)}`, 400);
  if (!code || !state) return page('Missing code or state.', 400);

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return page('Google is not configured on this server.', 503);

  const supabase = serviceClient();

  // Consume exactly once. An unconsumed state is a replayable ticket; a state that cannot be
  // consumed means this callback did not originate from our redirect.
  const { data: st } = await supabase
    .from('oauth_states')
    .update({ consumed_at: new Date().toISOString() })
    .eq('state', state)
    .eq('provider', 'google')
    .is('consumed_at', null)
    .select('tenant_id, metadata')
    .maybeSingle();
  if (!st) return page('That authorisation link has already been used, or did not come from here.', 400);

  const meta = (st.metadata ?? {}) as { requested_access?: string; expected_email?: string | null; return_to?: string | null };
  // Matches the consent route's DEFAULT_DRIVE_ACCESS — `picked`, not `readonly`. This is only the
  // fallback for a state row without a recorded choice, but if the two disagree the label shown to
  // the owner describes a different access level from the one he was actually sent to grant.
  // What was GRANTED is still read back from the token response below and never assumed.
  const requested: DriveAccess = isDriveAccess(meta.requested_access) ? meta.requested_access : 'picked';

  let tokens;
  try {
    tokens = await exchangeCode({ code, clientId, clientSecret, redirectUri });
  } catch (error) {
    return page(`Could not complete the connection: ${escapeHtml(String((error as Error).message).slice(0, 200))}`, 502);
  }

  const granted = grantedDriveAccess(tokens.scope);
  if (!granted) {
    // Nothing to store. A connection row with no Drive scope is worse than none: every later screen
    // would show Google as connected while every read returns nothing.
    return page(
      'Google connected, but Drive access was not granted — the Drive permission was unticked on the consent screen. ' +
        'Nothing was saved. Please start again and leave the Drive permission ticked.',
      400,
    );
  }

  const account = await connectedAccount(tokens.access_token);

  const { error } = await supabase.from('connections').upsert(
    {
      tenant_id: st.tenant_id,
      provider: 'google',
      // The Google account IS the org here — one Drive per connected account.
      provider_org_id: account.email ?? 'unknown',
      provider_org_name: account.email ?? account.name ?? null,
      access_token: tokens.access_token,
      // Only ever write a refresh token we were actually given. Google omits it on re-consent
      // without prompt=consent, and writing the absence would null out a working one.
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      scopes: tokens.scope ?? null,
      revoked_at: null,
      last_error: null,
    },
    { onConflict: 'tenant_id,provider,provider_org_id' },
  );
  if (error) {
    console.error('[connect/google] could not save connection:', error);
    return page('Google authorised the connection but it could not be saved. Please try again.', 500);
  }

  const notes: string[] = [];
  if (granted !== requested) {
    notes.push(
      `You asked for <strong>${LABEL[requested]}</strong> and Google granted <strong>${LABEL[granted]}</strong>. ` +
        'Kira will work within what was granted.',
    );
  }
  const expected = (meta.expected_email ?? '').trim().toLowerCase();
  if (expected && account.email && expected !== account.email.toLowerCase()) {
    notes.push(
      `You told Kira you use <strong>${escapeHtml(expected)}</strong> but signed in as ` +
        `<strong>${escapeHtml(account.email)}</strong>. If that is the wrong Drive, reconnect and pick the other account.`,
    );
  }
  if (!tokens.refresh_token) {
    notes.push('Google did not return a long-lived token this time. If the connection drops, reconnect once.');
  }

  const back = typeof meta.return_to === 'string' && meta.return_to.startsWith('https://') ? meta.return_to : null;

  return page(
    `<p>Connected <strong>${escapeHtml(account.email ?? 'your Google account')}</strong> with ` +
      `<strong>${LABEL[granted]}</strong>.</p>` +
      notes.map((n) => `<p style="color:#92400e">${n}</p>`).join('') +
      (back ? `<p><a href="${escapeHtml(back)}">Back to Kira</a></p>` : ''),
  );
}

function page(message: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<body style="font:16px/1.55 system-ui;max-width:34rem;margin:12vh auto;padding:0 1.25rem">` +
      `<h1 style="font-size:1.25rem">Google Drive</h1>${message.startsWith('<') ? message : `<p>${message}</p>`}</body>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
