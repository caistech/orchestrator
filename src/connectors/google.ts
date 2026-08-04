// The Google Drive connector.
//
// Why this exists at all: when the owner says "quote Trinh for the platform work", the useful answer
// is not a generic quote — it is a quote in HIS format, because the last twenty Factory2Key quotes
// are the only thing that knows what that is. Reading his Drive is how the system learns a format
// instead of inventing one. Everything downstream (format extraction, the Genome entry, the draft)
// depends on getting these bytes.
//
// It lives in the ORCHESTRATOR, not in Kira, for the same reason the Xero tokens do: a refresh token
// here is standing access to a business's entire document store. Kira holds none of it. The two
// systems meet over HTTP with a shared secret, and this side owns the credentials.
//
// WHERE GOOGLE DIFFERS FROM XERO, because the differences are all traps:
//
//   * A refresh token is returned ONCE, on first consent, unless `prompt=consent` forces it. Re-auth
//     without it returns an access token and NO refresh token — so a naive upsert overwrites a
//     working refresh token with null and the connection silently dies at the next expiry.
//   * Refresh tokens do NOT rotate per use (Xero's do), so the persist-or-die rule is softer here.
//     The write still happens before use.
//   * The user can UNTICK individual scopes on the consent screen. Asking for Drive is not receiving
//     it, so the granted scope is read back from the token response and recorded — never assumed.
//   * A Google Doc has no bytes to download. `alt=media` fails on native Docs/Sheets/Slides; they
//     must be EXPORTED to a readable type. This is the single most common reason a Drive integration
//     returns empty content for exactly the documents that matter.

import type { SupabaseClient } from '@supabase/supabase-js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const USERINFO = 'https://www.googleapis.com/oauth2/v2/userinfo';

/**
 * What the owner is choosing between at setup.
 *
 * Three, not two. `picked` is the least-privilege option and matters commercially as well as
 * ethically: `drive` and `drive.readonly` are RESTRICTED scopes, which drag Google's OAuth
 * verification and a third-party security assessment behind them before a production app may offer
 * them to the public. `drive.file` does not carry the same weight, so it is the option that lets a
 * cautious client — or an unverified app — still work.
 */
export type DriveAccess = 'full' | 'readonly' | 'picked';

import { CONTACTS_SCOPES } from './google-contacts';

const BASE_SCOPES = ['openid', 'email', 'profile'];

const DRIVE_SCOPE: Record<DriveAccess, string> = {
  full: 'https://www.googleapis.com/auth/drive',
  readonly: 'https://www.googleapis.com/auth/drive.readonly',
  picked: 'https://www.googleapis.com/auth/drive.file',
};

/**
 * Contacts is requested alongside Drive, not as a separate connection.
 *
 * The alternative — a second consent trip when the owner first asks to email someone by name — puts
 * an OAuth screen in the middle of a voice call, which is where it can least be dealt with. Both
 * scopes are read-only and merely SENSITIVE rather than restricted, so they add nothing to the
 * verification burden that Drive does not already carry.
 *
 * He can still untick them on the consent screen, and that is why nothing here assumes the request
 * was granted: `grantedContactsAccess` reads back what actually came, and a lookup without the scope
 * degrades to asking him for the address, exactly as it does today.
 */
export function scopesFor(access: DriveAccess): string {
  return [...BASE_SCOPES, DRIVE_SCOPE[access], ...CONTACTS_SCOPES].join(' ');
}

export function isDriveAccess(value: unknown): value is DriveAccess {
  return value === 'full' || value === 'readonly' || value === 'picked';
}

/**
 * The consent URL.
 *
 * `access_type=offline` + `prompt=consent` are both required to reliably receive a refresh token —
 * offline asks for one, and consent forces the screen even for a returning user, which is the only
 * way to get a NEW refresh token when we no longer hold a valid one.
 *
 * `login_hint` is why setup asks for the Google address explicitly rather than reusing the account
 * email: an owner is very often signed into several Google accounts, and without the hint Google
 * picks for them. Connecting the wrong Drive is not a visible failure — it is a Drive with none of
 * their quotes in it.
 */
export function consentUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  access: DriveAccess;
  loginHint?: string | null;
}): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', scopesFor(params.access));
  url.searchParams.set('state', params.state);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  if (params.loginHint) url.searchParams.set('login_hint', params.loginHint);
  return url.toString();
}

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

export async function exchangeCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as GoogleTokens;
}

/** Which Google account actually consented. Recorded so a wrong-account connect is visible. */
export async function connectedAccount(accessToken: string): Promise<{ email: string | null; name: string | null }> {
  const res = await fetch(USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return { email: null, name: null };
  const me = (await res.json()) as { email?: string; name?: string };
  return { email: me.email ?? null, name: me.name ?? null };
}

/** Did we actually receive Drive access, or did they untick it on the consent screen? */
export function grantedDriveAccess(scope: string | undefined | null): DriveAccess | null {
  const granted = (scope ?? '').split(/\s+/);
  if (granted.includes(DRIVE_SCOPE.full)) return 'full';
  if (granted.includes(DRIVE_SCOPE.readonly)) return 'readonly';
  if (granted.includes(DRIVE_SCOPE.picked)) return 'picked';
  return null;
}

export interface GoogleConnection {
  id: string;
  tenant_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string;
}

/**
 * A valid access token, refreshing if needed.
 *
 * Google access tokens last an hour. If the refresh fails the connection is marked with the reason
 * rather than throwing bare, because "we lost access to their Drive" is an operational fact someone
 * has to see — a revoked Google connection looks identical to an empty one from the outside.
 */
export async function accessTokenFor(
  supabase: SupabaseClient,
  connection: GoogleConnection,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  // 60s of headroom: a token that expires mid-request is indistinguishable from a revoked one.
  if (new Date(connection.expires_at).getTime() - Date.now() > 60_000) return connection.access_token;

  if (!connection.refresh_token) {
    const reason = 'no refresh token held — the owner must reconnect their Google account';
    await supabase.from('connections').update({ last_error: reason }).eq('id', connection.id);
    throw new Error(reason);
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: connection.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    await supabase.from('connections').update({ last_error: `refresh failed: ${detail}` }).eq('id', connection.id);
    throw new Error(`Google refresh failed (${res.status}): ${detail}`);
  }

  const tok = (await res.json()) as GoogleTokens;
  await supabase
    .from('connections')
    .update({
      access_token: tok.access_token,
      // Google usually omits refresh_token on a refresh. Keeping the existing one is the whole point
      // — writing `tok.refresh_token ?? null` here would null it out and kill the connection.
      ...(tok.refresh_token ? { refresh_token: tok.refresh_token } : {}),
      expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
      last_error: null,
    })
    .eq('id', connection.id);

  return tok.access_token;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  size?: string;
}

/**
 * Search the owner's Drive.
 *
 * `q` is Drive query syntax. Trashed files are always excluded — a quote the owner deleted is not a
 * precedent, and including them is how a superseded format comes back to life.
 */
export async function listFiles(
  accessToken: string,
  options: { query?: string; pageSize?: number } = {},
): Promise<DriveFile[]> {
  const url = new URL(`${DRIVE_API}/files`);
  const q = ['trashed = false', options.query].filter(Boolean).join(' and ');
  url.searchParams.set('q', q);
  url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,webViewLink,size)');
  url.searchParams.set('pageSize', String(options.pageSize ?? 25));
  url.searchParams.set('orderBy', 'modifiedTime desc');
  // Without these a file in a Shared Drive is invisible, which for a business is often where the
  // real documents are.
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Drive list failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { files?: DriveFile[] }).files ?? [];
}

/** Google-native types have no bytes; they are exported to something readable instead. */
const EXPORT_AS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

/** Types we can read as text directly. A PDF needs extraction and is handled by the ingest step. */
const READ_DIRECTLY = new Set(['text/plain', 'text/csv', 'text/markdown', 'application/json']);

/**
 * The text of a file, or null when this connector cannot read it.
 *
 * Returns null rather than throwing for an unsupported type: a Drive full of PDFs and images should
 * yield the documents we CAN read, not fail the whole sync on the first photo.
 */
export async function readFileText(accessToken: string, file: DriveFile): Promise<string | null> {
  const exportType = EXPORT_AS[file.mimeType];

  const url = exportType
    ? new URL(`${DRIVE_API}/files/${file.id}/export?mimeType=${encodeURIComponent(exportType)}`)
    : READ_DIRECTLY.has(file.mimeType)
      ? new URL(`${DRIVE_API}/files/${file.id}?alt=media`)
      : null;

  if (!url) return null;
  url.searchParams.set('supportsAllDrives', 'true');

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Drive read ${file.name} failed (${res.status}): ${(await res.text()).slice(0, 160)}`);
  return await res.text();
}

/** The live Google connection for a tenant, or null. */
export async function googleConnectionFor(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<(GoogleConnection & { scopes: string | null; provider_org_name: string | null }) | null> {
  const { data } = await supabase
    .from('connections')
    .select('id, tenant_id, access_token, refresh_token, expires_at, scopes, provider_org_name')
    .eq('tenant_id', tenantId)
    .eq('provider', 'google')
    .is('revoked_at', null)
    .maybeSingle();
  return (data as (GoogleConnection & { scopes: string | null; provider_org_name: string | null }) | null) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITING. Everything above reads; this is the half that lets the manual leave us.
//
// Kira's job is a migration — knowledge out of the owner's head and into the business's own
// systems. Until this existed every path terminated in our database, which for him is a worse place
// than his head: he cannot get it out without us.
//
// SCOPE. `drive.file` is enough for all of it. It grants access to files THIS APP CREATED and
// nothing else, so a write-back needs no sight of the rest of his Drive — which is also the easiest
// consent to put in front of a cautious owner, and (per `DriveAccess` above) the option that avoids
// Google's restricted-scope verification.
// ─────────────────────────────────────────────────────────────────────────────

const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';

/**
 * A string safe to interpolate into Drive query syntax.
 *
 * "O'Brien Plumbing" is not an exotic trading name, and an unescaped apostrophe ends the quoted
 * string early — turning the rest of the query into syntax Drive rejects, or worse, into a different
 * query. Drive escapes with a backslash, and the backslash itself must go first or it re-escapes the
 * escapes.
 *
 * Exported so it can be tested directly: this is the kind of two-line function that is either
 * exactly right or subtly wrong, and it is built from char codes rather than literals because
 * writing it through tooling has already corrupted the escapes once.
 */
export function driveQuoted(value: string): string {
  const BACKSLASH = String.fromCharCode(92);
  const APOSTROPHE = String.fromCharCode(39);
  return value.split(BACKSLASH).join(BACKSLASH + BACKSLASH).split(APOSTROPHE).join(BACKSLASH + APOSTROPHE);
}

/**
 * Find-or-create a folder, idempotently.
 *
 * FIND FIRST, ALWAYS. Drive lets two folders share a name in the same parent — it keys on id, not
 * name — so a create-first implementation silently accumulates a new folder per run and the owner
 * ends up with six "Operating Manual" folders, five of them stale. He would not report that as a
 * bug; he would conclude the product does not work and stop opening it.
 *
 * Restricted to files this app created (`drive.file` gives us nothing else anyway), so this cannot
 * adopt a folder of his that happens to share the name.
 */
export async function ensureFolder(
  accessToken: string,
  name: string,
  parentId?: string,
): Promise<{ id: string; created: boolean; webViewLink: string | null }> {
  const url = new URL(`${DRIVE_API}/files`);
  // The name is interpolated into Drive query syntax, so a single quote in a trading name would end
  // the string early — "O'Brien Plumbing" is not an exotic case. Drive escapes with a backslash.
  const safe = driveQuoted(name);
  url.searchParams.set(
    'q',
    [`mimeType = '${FOLDER_MIME}'`, `name = '${safe}'`, 'trashed = false', parentId ? `'${parentId}' in parents` : null]
      .filter(Boolean)
      .join(' and '),
  );
  url.searchParams.set('fields', 'files(id,webViewLink)');
  url.searchParams.set('pageSize', '1');

  const found = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!found.ok) throw new Error(`Drive folder lookup failed (${found.status}): ${(await found.text()).slice(0, 200)}`);
  const existing = ((await found.json()) as { files?: { id: string; webViewLink?: string }[] }).files?.[0];
  if (existing?.id) return { id: existing.id, created: false, webViewLink: existing.webViewLink ?? null };

  const res = await fetch(`${DRIVE_API}/files?fields=id,webViewLink`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) }),
  });
  if (!res.ok) throw new Error(`Drive folder create failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const created = (await res.json()) as { id: string; webViewLink?: string };
  return { id: created.id, created: true, webViewLink: created.webViewLink ?? null };
}

/**
 * Create or replace ONE document, as a native Google Doc.
 *
 * HTML IN, GOOGLE DOC OUT. The read path above notes that a native Doc has no bytes and must be
 * EXPORTED; writing is the same fact in reverse — upload HTML and let Drive convert. Markdown does
 * not convert, and a PDF would leave him a document he cannot edit, which stops being current the
 * day it is written.
 *
 * IDEMPOTENCY IS THE CALLER'S, deliberately. Drive cannot know that "Cash and invoicing" is the same
 * area it wrote last month, and matching on the title would break the moment an owner renames the
 * document — which is a thing he is supposed to be able to do, because it is his. So the caller
 * stores the returned `id` and hands it back; with an id this UPDATES, without one it CREATES.
 *
 * A MISSING FILE IS NOT AN ERROR. If he deleted it, `existingId` 404s — and the right response is to
 * write it again rather than to fail the run and leave a gap in his manual. That path is why this
 * returns `created`.
 */
export async function upsertDoc(
  accessToken: string,
  params: { folderId: string; title: string; html: string; existingId?: string | null },
): Promise<{ id: string; created: boolean; webViewLink: string | null }> {
  const body = (metadata: Record<string, unknown>) => {
    const boundary = `kira-${Math.random().toString(36).slice(2)}`;
    return {
      boundary,
      payload:
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${params.html}\r\n` +
        `--${boundary}--`,
    };
  };

  const send = async (method: 'POST' | 'PATCH', path: string, metadata: Record<string, unknown>) => {
    const { boundary, payload } = body(metadata);
    return fetch(`${DRIVE_UPLOAD}${path}${path.includes('?') ? '&' : '?'}uploadType=multipart&fields=id,webViewLink`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: payload,
    });
  };

  if (params.existingId) {
    // No `parents` on a PATCH: Drive rejects a parent change made this way, and the file is already
    // where it belongs. Sending it is how an update becomes a 403 nobody expects.
    const res = await send('PATCH', `/${params.existingId}`, { name: params.title, mimeType: DOC_MIME });
    if (res.ok) {
      const out = (await res.json()) as { id: string; webViewLink?: string };
      return { id: out.id, created: false, webViewLink: out.webViewLink ?? null };
    }
    // 404 = he deleted it; 403 = we no longer own it. Both mean "write it fresh" rather than fail.
    if (res.status !== 404 && res.status !== 403) {
      throw new Error(`Drive doc update failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
  }

  const res = await send('POST', '', { name: params.title, mimeType: DOC_MIME, parents: [params.folderId] });
  if (!res.ok) throw new Error(`Drive doc create failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const out = (await res.json()) as { id: string; webViewLink?: string };
  return { id: out.id, created: true, webViewLink: out.webViewLink ?? null };
}
