// GET /v1/tenants/:tenantId/lookup?kind=drive|contacts&q=… — READING what a tenant has connected.
//
// WHY THIS EXISTS. On 31 July the owner connected Google Drive and Contacts, then asked Kira to find
// his Lot 91 files and to check an address in his contacts. She could do neither: the connectors live
// here, and she had no way to reach them. Worse, she said "I looked through your documents, but I
// didn't find an exact email… in your contacts" — a search that never happened, reported as a result.
// He came away believing his contact book was missing an address.
//
// So this is the hands. It reads, and only reads: nothing here creates, sends, moves or deletes.
//
// THE CONTRACT IS "SAY WHICH WAY IT FAILED". Every response carries an explicit `ok`, and a failure
// carries a `reason` written to be SPOKEN. "Your Google account isn't connected", "you didn't grant
// access to Drive" and "I couldn't reach Google just now" send an owner to do three different things,
// and none of them is "nothing found" — which is what an empty list would have said. An empty result
// with ok:true means genuinely nothing matched; ok:false means we could not look. The agent is told
// to keep those apart, and this endpoint is what makes that possible rather than a matter of tone.
//
// @machine-callable

import { NextResponse } from 'next/server';

import { serviceClient } from '@/lib/supabase';
import { CONTRACT_VERSION, ORCHESTRATOR_AUTH_HEADER } from '@/src/contract';
import {
  accessTokenFor,
  googleConnectionFor,
  grantedDriveAccess,
  listFiles,
  type GoogleConnection,
} from '@/src/connectors/google';
import { resolveRecipientByName } from '@/src/connectors/google-contacts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many results come back. A spoken answer cannot carry more than a handful. */
const LIMIT = 8;

/** Written as char codes: every attempt to inline these escapes has been mangled in transit. */
const Q_MARK = String.fromCharCode(39);
const BACKSLASH = String.fromCharCode(92);

export async function GET(request: Request, context: { params: Promise<{ tenantId: string }> }) {
  const secret = process.env.ORCHESTRATOR_SECRET;
  if (!secret) return NextResponse.json({ error: 'Orchestrator not configured' }, { status: 503 });
  if (request.headers.get(ORCHESTRATOR_AUTH_HEADER) !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { tenantId } = await context.params;
  if (!UUID.test(tenantId)) return NextResponse.json({ error: 'Bad tenant' }, { status: 400 });

  const url = new URL(request.url);
  const kind = (url.searchParams.get('kind') ?? '').trim().toLowerCase();
  const q = (url.searchParams.get('q') ?? '').trim();

  if (kind !== 'drive' && kind !== 'contacts') {
    return NextResponse.json({ error: 'kind must be drive or contacts' }, { status: 400 });
  }
  if (!q) return NextResponse.json({ error: 'q is required' }, { status: 400 });

  const supabase = serviceClient();
  const connection = await googleConnectionFor(supabase, tenantId);

  // NOT-CONNECTED IS A DISTINCT ANSWER, not an empty one. This is the sentence that stops her saying
  // "I couldn't find it" about a Drive she was never given.
  if (!connection) {
    return NextResponse.json({
      version: CONTRACT_VERSION,
      ok: false,
      reason: "no Google account is connected — connect one in Settings and I'll be able to look",
      results: [],
    });
  }

  /* ------------------------------- CONTACTS ------------------------------- */
  if (kind === 'contacts') {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return NextResponse.json({
        version: CONTRACT_VERSION,
        ok: false,
        reason: "I can't reach your contacts just now",
        results: [],
      });
    }
    const resolution = await resolveRecipientByName(supabase, tenantId, q, clientId, clientSecret);
    if (resolution.status === 'unavailable') {
      return NextResponse.json({ version: CONTRACT_VERSION, ok: false, reason: resolution.reason, results: [] });
    }
    const matches =
      resolution.status === 'resolved'
        ? [resolution.match]
        : resolution.status === 'ambiguous'
          ? resolution.matches
          : [];
    return NextResponse.json({
      version: CONTRACT_VERSION,
      ok: true,
      // ok + zero results is the honest "I looked and there is no Roger" — the answer she claimed to
      // have without looking.
      results: matches.map((m) => ({ name: m.name, email: m.email, source: m.source })),
    });
  }

  /* -------------------------------- DRIVE --------------------------------- */
  const granted = grantedDriveAccess(connection.scopes);
  if (!granted) {
    return NextResponse.json({
      version: CONTRACT_VERSION,
      ok: false,
      reason:
        "your Google account is connected but Drive access wasn't granted — reconnect it in Settings and tick Drive",
      results: [],
    });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json({ version: CONTRACT_VERSION, ok: false, reason: "I can't reach your Drive just now", results: [] });
  }

  let accessToken: string;
  try {
    accessToken = await accessTokenFor(supabase, connection as GoogleConnection, clientId, clientSecret);
  } catch (error) {
    // accessTokenFor records the reason on the connection; the owner-facing sentence stays plain.
    console.error('[v1/lookup] drive token failed:', error);
    return NextResponse.json({
      version: CONTRACT_VERSION,
      ok: false,
      reason: "your Google connection needs renewing — reconnect it in Settings",
      results: [],
    });
  }

  try {
    // Name AND full text. An owner says "lot 91" meaning the folder, the plans, the approval letter
    // and the email thread — searching filenames alone finds the one that happens to be titled well
    // and misses the rest, which reads as "there's nothing there".
    // Drive query strings are single-quoted, so an apostrophe in a search term ends the string
    // and the rest is parsed as syntax. Escaped with a backslash, which is what the API expects.
    const escaped = q.split(Q_MARK).join(BACKSLASH + Q_MARK);
    const files = await listFiles(accessToken, {
      query: `(name contains '${escaped}' or fullText contains '${escaped}')`,
      pageSize: LIMIT,
    });
    return NextResponse.json({
      version: CONTRACT_VERSION,
      ok: true,
      results: files.map((f) => ({
        name: f.name,
        id: f.id,
        mimeType: f.mimeType,
        // A link is what he actually wants — he opens it himself rather than having it read out.
        // Taken from Drive rather than constructed: a built URL is wrong for a folder or a Google Doc.
        link: (f as { webViewLink?: string }).webViewLink ?? null,
        modifiedAt: (f as { modifiedTime?: string }).modifiedTime ?? null,
      })),
    });
  } catch (error) {
    console.error('[v1/lookup] drive search failed:', error);
    return NextResponse.json({
      version: CONTRACT_VERSION,
      ok: false,
      reason: "I couldn't reach your Drive just now",
      results: [],
    });
  }
}
