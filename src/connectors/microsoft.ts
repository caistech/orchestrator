// The Microsoft OneDrive connector — the twin of `google.ts`, deliberately.
//
// Why it exists: roughly two thirds of the known contact base runs on Microsoft, not Google, by MX
// record — `plausible.gg`, `linkbusiness.com.au`, `aerion.com.au` and `garda.com.au` all resolve to
// Microsoft, and Garda is the live first-customer lead. An owner whose twenty quotes live in OneDrive
// gets nothing from a Drive-only product, and "read his existing documents so she writes in HIS
// format" is the promise, not the platform.
//
// It lives in the ORCHESTRATOR for the same reason the Google and Xero tokens do: a refresh token
// here is standing access to a business's entire document store. Kira holds none of it.
//
// SHAPE IS MIRRORED ON PURPOSE. Same exported function names, same return shapes, same argument
// order as `google.ts`, per the SHARED_SERVICES build-alike rule — when this and the Google client
// are eventually extracted into `@caistech/google-workspace`'s Microsoft sibling, it should be a lift
// rather than a rewrite. Where the shapes DIVERGE it is because the vendors genuinely differ, and
// every such place is commented, because a silent divergence is the thing that makes the extraction
// expensive later.
//
// WHERE MICROSOFT DIFFERS FROM GOOGLE, because the differences are all traps:
//
//   * REFRESH TOKENS ROTATE. Microsoft returns a NEW refresh token on nearly every refresh and
//     invalidates the old one. Google usually returns none and you keep the one you have. So the
//     Google client's `...(tok.refresh_token ? {…} : {})` guard — correct there — would here leave a
//     dead token in the row the moment Microsoft rotates. This client persists whatever it is given,
//     every time, before the token is used. Same discipline as Xero.
//   * `offline_access` IS THE REFRESH TOKEN. There is no `access_type=offline`; omit the scope and
//     you get an access token, no refresh token, and a connection that dies in an hour with no error.
//   * NO PER-FILE CONSENT. Google's `drive.file` grants access to individually-picked files and
//     nothing else. Graph has no delegated equivalent, so the `picked` tier does NOT exist here — see
//     `FilesAccess`. Inventing one would mean a label promising per-file access over a grant covering
//     the whole OneDrive, which is precisely the surprise `/setup/drive` was fixed to stop.
//   * OFFICE FILES HAVE BYTES BUT NOT TEXT. A Google Doc must be EXPORTED to be read; a `.docx` has
//     real bytes you can download and still cannot read, because Graph converts only to PDF — there
//     is no text conversion. So the single most valuable case (his existing quotes, which are
//     `.docx`) needs a text extractor this connector deliberately does not contain. See
//     `readFileText`.

import type { SupabaseClient } from '@supabase/supabase-js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * Which Microsoft sign-in audience this app talks to.
 *
 * `common` accepts both work/school accounts and personal Microsoft accounts, which is right for an
 * SME owner who may be on either and frequently does not know which. It is the answer for every
 * deployment we can currently foresee, so it is the answer you get unless somebody deliberately says
 * otherwise.
 *
 * ⚠️ WHY THIS IS A FLAG AND NOT JUST A STRING. A bare `MICROSOFT_TENANT` looks like a config value
 * that is helpful to fill in — and setting it to a tenant GUID silently restricts the app to ONE
 * organisation. Every other client's consent then fails with a Microsoft error about the account not
 * existing in the directory, which reads as their problem rather than ours. The blast radius is the
 * whole customer base and the cause is one plausible-looking env var.
 *
 * So the override is gated: `MICROSOFT_TENANT_OVERRIDE` must be exactly `'true'` before
 * `MICROSOFT_TENANT` is read at all. Anything else — unset, empty, `'false'`, `'TRUE'`, a typo — is
 * `common`, because **the safe state should be the one you fall into by accident**. That is the same
 * shape as `STRIPE_LIVE_MODE` in `@caistech/subscription-billing`, and it is here for the same
 * reason: the dangerous setting should require an act of intent, and be visible in a diff.
 *
 * FAIL-CLOSED IN BOTH DIRECTIONS. Enabling the override without supplying a tenant throws rather
 * than quietly falling back to `common` — falling back would be BROADER than what the operator
 * asked for, and silently ignoring a restriction somebody deliberately switched on is the wrong way
 * to be wrong about an audience boundary.
 *
 * Read at CALL TIME, never at module scope: a value baked at import cannot be changed without a
 * redeploy, and module-scope construction is what has broken Next build-time page-data collection
 * in this portfolio before.
 */
export function microsoftTenant(): string {
  if (process.env.MICROSOFT_TENANT_OVERRIDE !== 'true') return 'common';

  const tenant = (process.env.MICROSOFT_TENANT || '').trim();
  if (!tenant) {
    throw new Error(
      'MICROSOFT_TENANT_OVERRIDE is true but MICROSOFT_TENANT is empty — set the tenant, or turn the override off.',
    );
  }
  return tenant;
}

const authUrl = () => `https://login.microsoftonline.com/${microsoftTenant()}/oauth2/v2.0/authorize`;
const tokenUrl = () => `https://login.microsoftonline.com/${microsoftTenant()}/oauth2/v2.0/token`;

/**
 * What the owner is choosing between at setup.
 *
 * THREE TIERS, AND THEY ARE NOT GOOGLE'S THREE. `DriveAccess` is `full | readonly | picked`, where
 * `picked` (`drive.file`) reaches only files the owner explicitly hands over. **Graph has no
 * delegated per-file scope**, so there is nothing honest to map `picked` onto: the narrowest thing
 * Microsoft will grant is the owner's whole OneDrive. A tier called `picked` that quietly granted
 * everything would be a label contradicting its own consent screen — the exact defect fixed on
 * `/setup/drive` in August, where the page said Drive and Google asked for the address book.
 *
 * So the tiers are named for what they actually grant:
 *
 *   readonly  — his own OneDrive, read. Cannot file anything back.
 *   readwrite — his own OneDrive, read and write. The default.
 *   all       — additionally everything he can reach, including files shared with him and SharePoint
 *               document libraries. Much wider than it sounds inside a tenant with SharePoint.
 *
 * `readwrite` is the default for the same reason the Google route defaults to `picked`: it is the
 * least privilege that can still file a finished handover pack back into his own storage, which is
 * the point of the product. An owner who takes `readonly` gets a Kira who can read his quotes and
 * can never give him anything back, and discovering that months later means asking a cautious
 * sixty-something for a second consent — which does not happen.
 */
export type FilesAccess = 'readonly' | 'readwrite' | 'all';

/**
 * `offline_access` is not optional decoration — it IS the refresh token. Without it every connection
 * silently expires in about an hour and reads as "not connected" with no error anywhere.
 */
const BASE_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'https://graph.microsoft.com/User.Read',
];

const FILES_SCOPE: Record<FilesAccess, string> = {
  readonly: 'https://graph.microsoft.com/Files.Read',
  readwrite: 'https://graph.microsoft.com/Files.ReadWrite',
  all: 'https://graph.microsoft.com/Files.ReadWrite.All',
};

/**
 * Mail is NOT requested, and this is a deliberate omission rather than an oversight.
 *
 * Two reasons, and the second is the one that would otherwise get lost:
 *
 *   1. `Mail.Send` routes around the compliance path everything outbound goes through — the tenant's
 *      sender identity, the Spam Act footer, the suppression store, the AU-only jurisdiction guard
 *      and the approval gate. Same argument as `gmail.send`, which is also never requested.
 *   2. THERE IS NO DRAFT-ONLY PERMISSION. Creating a draft needs `Mail.ReadWrite`, which also reads
 *      the entire mailbox. Gmail at least has `gmail.compose`, which stops short of read. So a
 *      Microsoft mailbox tier offering `none | draft | read` would really be `none | read | read`,
 *      and an owner choosing "just drafts" would be granting everything. If mail is ever added here
 *      that has to be said on the consent page in those words, or not offered.
 *
 * `graph-no-send.test.ts` asserts the absence repo-wide so it cannot be reopened quietly.
 */

export function scopesFor(access: FilesAccess): string {
  return [...BASE_SCOPES, FILES_SCOPE[access]].join(' ');
}

export function isFilesAccess(value: unknown): value is FilesAccess {
  return value === 'readonly' || value === 'readwrite' || value === 'all';
}

/**
 * Did we actually receive file access, or did they decline it?
 *
 * The twin of `grantedDriveAccess`, and it exists for the same reason: asking is not receiving.
 * Ordered widest-first so a grant carrying both `Files.ReadWrite.All` and a narrower scope reports
 * the widest thing it can actually do.
 *
 * ⚠️ Microsoft returns granted scopes in the token response WITHOUT the resource prefix — `Files.Read`
 * rather than `https://graph.microsoft.com/Files.Read` — even when the request used full URIs. A
 * naive `granted.includes(FILES_SCOPE[x])` therefore matches nothing and every connection reads as
 * "declined". Compared on the trailing segment for that reason.
 */
export function grantedFilesAccess(scope: string | undefined | null): FilesAccess | null {
  const granted = new Set(
    (scope ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => s.split('/').pop() as string),
  );
  if (granted.has('Files.ReadWrite.All')) return 'all';
  if (granted.has('Files.ReadWrite')) return 'readwrite';
  if (granted.has('Files.Read')) return 'readonly';
  return null;
}

/**
 * The consent URL.
 *
 * `prompt=consent` forces the screen even for a returning user, which is the only reliable way to be
 * issued a fresh refresh token when we no longer hold a working one.
 *
 * `login_hint` is why setup asks for the Microsoft address explicitly rather than reusing the account
 * email: owners are commonly signed into a personal and a work account at once, and without the hint
 * Microsoft picks. Connecting the wrong OneDrive is not a visible failure — it is a OneDrive with
 * none of their documents in it.
 */
export function consentUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  access: FilesAccess;
  loginHint?: string | null;
}): string {
  const url = new URL(authUrl());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', scopesFor(params.access));
  url.searchParams.set('state', params.state);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('prompt', 'consent');
  if (params.loginHint) url.searchParams.set('login_hint', params.loginHint);
  return url.toString();
}

export interface MicrosoftTokens {
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
}): Promise<MicrosoftTokens> {
  const res = await fetch(tokenUrl(), {
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
  if (!res.ok) {
    throw new Error(`Microsoft token exchange failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as MicrosoftTokens;
}

/**
 * Which Microsoft account actually consented. Recorded so a wrong-account connect is visible.
 *
 * `mail` is null on plenty of real accounts (no Exchange licence), and `userPrincipalName` is the
 * address the owner actually recognises in that case — so it is the fallback rather than a second
 * field nobody reads.
 */
export async function connectedAccount(accessToken: string): Promise<{ email: string | null; name: string | null }> {
  const res = await fetch(`${GRAPH}/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return { email: null, name: null };
  const me = (await res.json()) as { mail?: string; userPrincipalName?: string; displayName?: string };
  return { email: me.mail ?? me.userPrincipalName ?? null, name: me.displayName ?? null };
}

export interface MicrosoftConnection {
  id: string;
  tenant_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string;
}

/**
 * A valid access token, refreshing if needed.
 *
 * ⚠️ THE ROTATION TRAP, and it is the one difference most likely to be got wrong by someone reading
 * the Google client first. Microsoft issues a NEW refresh token on nearly every refresh and
 * invalidates the previous one. The Google client deliberately keeps its existing refresh token when
 * the response omits one — correct for Google, fatal here: the row would keep a token Microsoft has
 * already retired, and the connection dies at the next refresh with an `invalid_grant` nobody can
 * trace back to this line.
 *
 * So the new refresh token is persisted whenever one is returned, and the write happens BEFORE the
 * token is handed to a caller. If the write fails we have already spent a single-use token, and
 * returning it would mean doing real work against a credential we can no longer renew.
 */
export async function accessTokenFor(
  supabase: SupabaseClient,
  connection: MicrosoftConnection,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  // 60s of headroom: a token that expires mid-request is indistinguishable from a revoked one.
  if (new Date(connection.expires_at).getTime() - Date.now() > 60_000) return connection.access_token;

  if (!connection.refresh_token) {
    const reason = 'no refresh token held — the owner must reconnect their Microsoft account';
    await supabase.from('connections').update({ last_error: reason }).eq('id', connection.id);
    throw new Error(reason);
  }

  const res = await fetch(tokenUrl(), {
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
    throw new Error(`Microsoft refresh failed (${res.status}): ${detail}`);
  }

  const tok = (await res.json()) as MicrosoftTokens;

  const { error } = await supabase
    .from('connections')
    .update({
      access_token: tok.access_token,
      // ROTATION: persist whatever came back. Unlike Google, silence here is rare and a returned
      // token means the old one is already dead.
      ...(tok.refresh_token ? { refresh_token: tok.refresh_token } : {}),
      expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
      last_error: null,
    })
    .eq('id', connection.id);
  if (error) {
    // Persist-or-die. We have consumed a single-use refresh token; handing the access token back
    // while its replacement is unsaved buys one request and loses the connection permanently.
    throw new Error(`Microsoft refresh succeeded but could not be saved (${error.message}) — not proceeding`);
  }

  return tok.access_token;
}

/** The live Microsoft connection for a tenant, or null. */
export async function microsoftConnectionFor(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<(MicrosoftConnection & { scopes: string | null; provider_org_name: string | null }) | null> {
  const { data } = await supabase
    .from('connections')
    .select('id, tenant_id, access_token, refresh_token, expires_at, scopes, provider_org_name')
    .eq('tenant_id', tenantId)
    .eq('provider', 'microsoft')
    .is('revoked_at', null)
    .maybeSingle();
  return (data as (MicrosoftConnection & { scopes: string | null; provider_org_name: string | null }) | null) ?? null;
}

export interface DriveItem {
  id: string;
  name: string;
  /** Absent on a folder. Graph nests the mime type; it is flattened here to match `DriveFile`. */
  mimeType?: string;
  lastModifiedDateTime?: string;
  webUrl?: string;
  size?: number;
  isFolder: boolean;
}

interface GraphItem {
  id: string;
  name: string;
  lastModifiedDateTime?: string;
  webUrl?: string;
  size?: number;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
}

const asDriveItem = (item: GraphItem): DriveItem => ({
  id: item.id,
  name: item.name,
  mimeType: item.file?.mimeType,
  lastModifiedDateTime: item.lastModifiedDateTime,
  webUrl: item.webUrl,
  size: item.size,
  isFolder: Boolean(item.folder),
});

/**
 * A string safe to interpolate into an OData query.
 *
 * ⚠️ THE ESCAPE RULE IS NOT DRIVE'S. `driveQuoted` escapes an apostrophe with a BACKSLASH because
 * that is what Drive query syntax wants. OData — which is what `search(q='…')` and `$filter` parse —
 * escapes a single quote by DOUBLING it, and treats a backslash as an ordinary character. Using the
 * Drive rule here would send a literal backslash into the query and leave the string unterminated.
 *
 * "O'Brien Plumbing" is not an exotic trading name. Exported so it can be tested directly: this is
 * the kind of two-line function that is either exactly right or subtly wrong, and it is built from a
 * char code rather than a literal because writing escapes through tooling has corrupted them here
 * before.
 */
export function odataQuoted(value: string): string {
  const APOSTROPHE = String.fromCharCode(39);
  return value.split(APOSTROPHE).join(APOSTROPHE + APOSTROPHE);
}

/**
 * Search the owner's OneDrive.
 *
 * The twin of `listFiles`. Graph's `search(q=…)` already spans the whole drive including nested
 * folders, and — unlike Drive — it does not return trashed items, so there is no `trashed = false`
 * equivalent to remember.
 *
 * An empty query lists the root rather than searching for nothing, because "show me what's there" is
 * a real question and Graph's search endpoint answers it with an empty set.
 */
export async function listFiles(
  accessToken: string,
  options: { query?: string; pageSize?: number } = {},
): Promise<DriveItem[]> {
  const q = (options.query ?? '').trim();
  const path = q
    ? `${GRAPH}/me/drive/root/search(q='${odataQuoted(q)}')`
    : `${GRAPH}/me/drive/root/children`;

  const url = new URL(path);
  url.searchParams.set('$top', String(options.pageSize ?? 25));
  url.searchParams.set('$select', 'id,name,file,folder,lastModifiedDateTime,webUrl,size');
  // Newest first, matching the Drive client. Graph rejects $orderby on search results, so it is only
  // applied to a listing — sorting a search would 400 the whole call.
  if (!q) url.searchParams.set('$orderby', 'lastModifiedDateTime desc');

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`OneDrive list failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { value?: GraphItem[] }).value?.map(asDriveItem) ?? [];
}

/** Types we can read as text directly. */
const READ_DIRECTLY = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'text/html',
]);

/**
 * The text of a file, or null when this connector cannot read it.
 *
 * ⚠️ THIS IS WHERE MICROSOFT IS GENUINELY WORSE THAN GOOGLE, and it matters because it hits the most
 * valuable case. A Google Doc has no bytes and must be exported — but it exports to `text/plain`, so
 * the Drive client reads his existing quotes as text in one call. A `.docx` is the opposite: real
 * bytes you can download, and no text conversion at all. Graph converts to PDF and nothing else.
 *
 * So `readFileText` returns null for `.docx`, `.xlsx` and `.pptx`, and the caller gets the documents
 * it CAN read rather than a failure — the same degrade-don't-fake contract as the Drive client, but
 * hiding a much bigger hole, because on Microsoft the owner's quotes are almost always `.docx`.
 *
 * Closing it needs a text extractor, which deliberately does not live here: `SHARED_SERVICES.md`
 * already names "Document text extraction (PDF/docx/xlsx → text)" as an open extraction candidate
 * that must NOT be forked per product. Wire that in when it exists; do not grow a parser in this
 * file.
 */
export async function readFileText(accessToken: string, file: DriveItem): Promise<string | null> {
  if (file.isFolder) return null;
  if (!file.mimeType || !READ_DIRECTLY.has(file.mimeType)) return null;

  const res = await fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(file.id)}/content`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`OneDrive read ${file.name} failed (${res.status}): ${(await res.text()).slice(0, 160)}`);
  }
  return await res.text();
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITING. Everything above reads; this is the half that lets the manual leave us.
//
// Same argument as the Drive client: until a write path existed, every route terminated in our
// database — which for the owner is a worse place than his own head, because he cannot get it out
// without us. Filing it back into his OneDrive is the migration actually completing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find-or-create a folder under the drive root, idempotently.
 *
 * FIND FIRST, ALWAYS — for the same reason as the Drive client, though Graph reaches the answer
 * differently. Addressing by path (`/root:/Name:`) is a single call and returns the existing folder
 * or 404s, so there is no query to escape and no chance of matching two folders with one name.
 *
 * ⚠️ `conflictBehavior: 'fail'` on the create, NOT the tempting `'replace'`. A race between two runs
 * should lose harmlessly — the loser re-reads the winner's folder — whereas `replace` would delete a
 * folder and its contents. `'rename'` is worse still: it silently produces "Kira 1", "Kira 2", which
 * is the accumulating-duplicates failure the Drive client's comment describes, arriving by a
 * different road.
 */
export async function ensureFolder(
  accessToken: string,
  name: string,
  parentId?: string,
): Promise<{ id: string; created: boolean; webViewLink: string | null }> {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const encoded = encodeURIComponent(name);
  const lookup = parentId
    ? `${GRAPH}/me/drive/items/${encodeURIComponent(parentId)}:/${encoded}:`
    : `${GRAPH}/me/drive/root:/${encoded}:`;

  const found = await fetch(`${lookup}?$select=id,webUrl,folder`, { headers: auth });
  if (found.ok) {
    const item = (await found.json()) as GraphItem;
    if (item.folder) return { id: item.id, created: false, webViewLink: item.webUrl ?? null };
    // A FILE of that name already sits there. Creating the folder anyway would give the owner two
    // things with one name and no way to tell them apart, so this stops and says which.
    throw new Error(`OneDrive already holds a file named "${name}" where the folder should go`);
  }
  if (found.status !== 404) {
    throw new Error(`OneDrive folder lookup failed (${found.status}): ${(await found.text()).slice(0, 200)}`);
  }

  const parent = parentId
    ? `${GRAPH}/me/drive/items/${encodeURIComponent(parentId)}/children`
    : `${GRAPH}/me/drive/root/children`;
  const res = await fetch(`${parent}?$select=id,webUrl`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
  });

  if (res.status === 409) {
    // Another run created it between our lookup and our create. Re-read rather than fail: the folder
    // exists, which is all the caller asked for.
    const again = await fetch(`${lookup}?$select=id,webUrl`, { headers: auth });
    if (again.ok) {
      const item = (await again.json()) as GraphItem;
      return { id: item.id, created: false, webViewLink: item.webUrl ?? null };
    }
  }
  if (!res.ok) throw new Error(`OneDrive folder create failed (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const created = (await res.json()) as GraphItem;
  return { id: created.id, created: true, webViewLink: created.webUrl ?? null };
}

/**
 * Simple upload tops out here. Above it Graph requires a chunked upload session, which is a different
 * shape and is not built — a handover document is a few tens of kilobytes, and silently truncating or
 * half-writing a larger one would be worse than refusing it.
 */
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;

/**
 * Create or replace ONE document.
 *
 * HTML IN, HTML OUT — and this is a real divergence from the Drive client, stated rather than hidden.
 * There, HTML is uploaded and Drive converts it to a native Google Doc, so the owner opens something
 * editable in the tool he already uses. Graph performs no such conversion on upload: posting HTML
 * bytes as `.docx` produces a corrupt file that Word refuses to open. Writing genuine `.docx` needs
 * an OOXML writer, which does not belong in a connector.
 *
 * So this writes a `.html` file, which Word opens and edits perfectly well, and OneDrive previews in
 * the browser. It is one step less polished than the Drive path and it keeps the property that
 * actually matters: the document is his, in his storage, editable without us.
 *
 * IDEMPOTENCY IS THE CALLER'S, deliberately, exactly as in the Drive client — the caller stores the
 * returned `id` and hands it back. With an id this UPDATES, without one it CREATES. Matching on
 * title would break the moment an owner renames the file, which he is entitled to do because it is
 * his.
 *
 * A MISSING FILE IS NOT AN ERROR. If he deleted it, the update 404s, and the right response is to
 * write it again rather than fail the run and leave a gap in his manual.
 */
export async function upsertDoc(
  accessToken: string,
  params: { folderId: string; title: string; html: string; existingId?: string | null },
): Promise<{ id: string; created: boolean; webViewLink: string | null }> {
  const bytes = Buffer.byteLength(params.html, 'utf8');
  if (bytes > SIMPLE_UPLOAD_LIMIT) {
    throw new Error(`Document "${params.title}" is ${Math.round(bytes / 1024)}KB — too large for a simple upload`);
  }

  const name = params.title.endsWith('.html') ? params.title : `${params.title}.html`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'text/html; charset=utf-8',
  };

  if (params.existingId) {
    const res = await fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(params.existingId)}/content`, {
      method: 'PUT',
      headers,
      body: params.html,
    });
    if (res.ok) {
      const out = (await res.json()) as GraphItem;
      return { id: out.id, created: false, webViewLink: out.webUrl ?? null };
    }
    // 404 = he deleted it; 403 = we can no longer write it. Both mean "write it fresh" rather than
    // fail the whole run.
    if (res.status !== 404 && res.status !== 403) {
      throw new Error(`OneDrive doc update failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
  }

  const create = await fetch(
    `${GRAPH}/me/drive/items/${encodeURIComponent(params.folderId)}:/${encodeURIComponent(name)}:/content` +
      `?@microsoft.graph.conflictBehavior=replace`,
    { method: 'PUT', headers, body: params.html },
  );
  if (!create.ok) {
    throw new Error(`OneDrive doc create failed (${create.status}): ${(await create.text()).slice(0, 200)}`);
  }
  const out = (await create.json()) as GraphItem;
  return { id: out.id, created: true, webViewLink: out.webUrl ?? null };
}
