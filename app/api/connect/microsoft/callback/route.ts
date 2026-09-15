// Microsoft consent callback — exchange the code, record the connection, and say plainly what was
// actually granted.
//
// The twin of the Google callback, and the same two things are checked here that a naive callback
// skips, because "connected" is a word that hides failure well:
//
//   1. WHICH SCOPES CAME BACK. A consent screen lets a user decline permissions, and an admin policy
//      can narrow them further without telling the user. The token response carries what was really
//      granted, so a request for write access that came back read-only is caught now rather than as a
//      failed save a week later.
//   2. WHICH ACCOUNT CONSENTED. Owners are routinely signed into a work and a personal Microsoft
//      account at once. Connecting the wrong one succeeds, and the OneDrive contains none of their
//      work — a failure with no error anywhere. So the addresses are compared and the mismatch is
//      said out loud.
//
// @machine-callable — Microsoft redirects a browser here; the middleware must not gate it.

import { serviceClient } from '@/lib/supabase';
import {
  connectedAccount,
  exchangeCode,
  grantedFilesAccess,
  isFilesAccess,
  type FilesAccess,
} from '@/src/connectors/microsoft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LABEL: Record<FilesAccess, string> = {
  readonly: 'read-only access to your OneDrive',
  readwrite: 'read and write access to your OneDrive',
  all: 'read and write access to your OneDrive, shared files and SharePoint',
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const denied = url.searchParams.get('error');

  if (denied) {
    // Microsoft puts the useful half in `error_description` — "AADSTS65004: User declined to consent"
    // or an admin-consent-required message. Passing only `error` back would show a bare
    // `access_denied` for a tenant-policy block the owner cannot act on without knowing that is what
    // it was.
    const detail = url.searchParams.get('error_description');
    return page(
      `Microsoft declined the connection: ${escapeHtml(denied)}` +
        (detail ? `<br><span style="color:#57534e">${escapeHtml(detail.slice(0, 300))}</span>` : ''),
      400,
    );
  }
  if (!code || !state) return page('Missing code or state.', 400);

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return page('Microsoft is not configured on this server.', 503);

  const supabase = serviceClient();

  // Consume exactly once. An unconsumed state is a replayable ticket; a state that cannot be
  // consumed means this callback did not originate from our redirect.
  const { data: st } = await supabase
    .from('oauth_states')
    .update({ consumed_at: new Date().toISOString() })
    .eq('state', state)
    .eq('provider', 'microsoft')
    .is('consumed_at', null)
    .select('tenant_id, metadata')
    .maybeSingle();
  if (!st) return page('That authorisation link has already been used, or did not come from here.', 400);

  const meta = (st.metadata ?? {}) as {
    requested_access?: string;
    expected_email?: string | null;
    return_to?: string | null;
  };
  // Matches the consent route's DEFAULT_FILES_ACCESS. Only the fallback for a state row without a
  // recorded choice, but if the two disagree the label shown to the owner describes a different
  // access level from the one he was actually sent to grant. What was GRANTED is still read back from
  // the token response below and never assumed.
  const requested: FilesAccess = isFilesAccess(meta.requested_access) ? meta.requested_access : 'readwrite';

  let tokens;
  try {
    tokens = await exchangeCode({ code, clientId, clientSecret, redirectUri });
  } catch (error) {
    return page(`Could not complete the connection: ${escapeHtml(String((error as Error).message).slice(0, 200))}`, 502);
  }

  const granted = grantedFilesAccess(tokens.scope);
  if (!granted) {
    // Nothing to store. A connection row with no file scope is worse than none: every later screen
    // would show Microsoft as connected while every read returns nothing.
    return page(
      'Microsoft connected, but access to your files was not granted — the OneDrive permission was declined on the ' +
        'consent screen, or your organisation blocks it. Nothing was saved. Please start again, or ask whoever ' +
        'administers your Microsoft 365 account to approve it.',
      400,
    );
  }

  const account = await connectedAccount(tokens.access_token);

  const { error } = await supabase.from('connections').upsert(
    {
      tenant_id: st.tenant_id,
      provider: 'microsoft',
      // The Microsoft account IS the org here — one OneDrive per connected account.
      provider_org_id: account.email ?? 'unknown',
      provider_org_name: account.email ?? account.name ?? null,
      access_token: tokens.access_token,
      // ⚠️ Written unconditionally where the Google callback writes conditionally. Microsoft ROTATES
      // refresh tokens, so the one in this response replaces any we hold — see `accessTokenFor` in
      // src/connectors/microsoft.ts. On this path there is nothing to preserve anyway: a fresh
      // consent always issues one.
      refresh_token: tokens.refresh_token ?? null,
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      scopes: tokens.scope ?? null,
      revoked_at: null,
      last_error: null,
    },
    { onConflict: 'tenant_id,provider,provider_org_id' },
  );
  if (error) {
    console.error('[connect/microsoft] could not save connection:', error);
    return page('Microsoft authorised the connection but it could not be saved. Please try again.', 500);
  }

  const notes: string[] = [];
  if (granted !== requested) {
    notes.push(
      `You asked for <strong>${LABEL[requested]}</strong> and Microsoft granted <strong>${LABEL[granted]}</strong>. ` +
        'Kira will work within what was granted.',
    );
  }
  const expected = (meta.expected_email ?? '').trim().toLowerCase();
  if (expected && account.email && expected !== account.email.toLowerCase()) {
    notes.push(
      `You told Kira you use <strong>${escapeHtml(expected)}</strong> but signed in as ` +
        `<strong>${escapeHtml(account.email)}</strong>. If that is the wrong account, reconnect and pick the other one.`,
    );
  }
  if (!tokens.refresh_token) {
    // On Microsoft this is close to fatal rather than cosmetic: without `offline_access` being
    // honoured there is nothing to refresh with, and the connection stops working within the hour.
    notes.push(
      'Microsoft did not return a long-lived token, so this connection will stop working shortly. Please reconnect, ' +
        'and if it happens again let us know.',
    );
  }

  const back = typeof meta.return_to === 'string' && meta.return_to.startsWith('https://') ? meta.return_to : null;

  return page(
    `<p>Connected <strong>${escapeHtml(account.email ?? 'your Microsoft account')}</strong> with ` +
      `<strong>${LABEL[granted]}</strong>.</p>` +
      notes.map((n) => `<p style="color:#92400e">${n}</p>`).join('') +
      (back ? `<p><a href="${escapeHtml(back)}">Back to Kira</a></p>` : ''),
  );
}

function page(message: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<body style="font:16px/1.55 system-ui;max-width:34rem;margin:12vh auto;padding:0 1.25rem">` +
      `<h1 style="font-size:1.25rem">OneDrive</h1>${message.startsWith('<') ? message : `<p>${message}</p>`}</body>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
