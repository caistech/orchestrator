// POST /v1/tenants/:tenantId/record — WRITING the owner's manual into his own system of record.
//
// The sibling of /lookup, and its opposite: that one reads and only reads, this one is the first
// endpoint in the orchestrator that CREATES something in a customer's own account.
//
// WHY IT EXISTS. Kira's job is a migration — knowledge out of the owner's head and into the
// business's own systems — and until now every path terminated in our database, which for him is a
// worse place than his head because he cannot get it out without us. This is the leg that makes the
// promise true.
//
// KIRA DOES NOT KNOW WHERE THIS GOES, deliberately. It renders documents and says "file these"; the
// destination is resolved here from what the tenant has connected. That is the anti-lock-in
// guarantee: a caller with no opinion about the vendor cannot be locked to one, and swapping is a
// change on one side of an HTTP boundary rather than a refactor. See docs/SYSTEM_OF_RECORD_PORT.md.
//
// THE SAME "SAY WHICH WAY IT FAILED" CONTRACT as /lookup, and it matters more here. "I filed your
// manual" when nothing was written is the failure that costs an owner his trust in the whole
// product — worse than an error, because he will not find out until he goes looking for a document
// that is not there. Every response carries `ok`, and a failure carries a `reason` written to be
// spoken.
//
// @machine-callable

import { NextResponse } from 'next/server';

import { serviceClient } from '@/lib/supabase';
import { CONTRACT_VERSION, ORCHESTRATOR_AUTH_HEADER } from '@/src/contract';
import {
  accessTokenFor,
  ensureFolder,
  googleConnectionFor,
  grantedDriveAccess,
  upsertDoc,
  type GoogleConnection,
} from '@/src/connectors/google';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One area of the manual. `ref` is the handle the CALLER stored from a previous run.
 *
 * Idempotency is the caller's on purpose: Drive cannot know that "Cash and invoicing" is the same
 * area it wrote last month, and matching on the title would break the moment the owner renames the
 * document — which he is supposed to be able to do, because it is his.
 */
interface IncomingDocument {
  key: string;
  title: string;
  html: string;
  ref?: string | null;
}

/** A whole run refused, in the shape the caller can speak. */
const refuse = (reason: string, status = 200) =>
  NextResponse.json({ version: CONTRACT_VERSION, ok: false, reason, results: [] }, { status });

export async function POST(request: Request, context: { params: Promise<{ tenantId: string }> }) {
  const secret = process.env.ORCHESTRATOR_SECRET;
  if (!secret) return NextResponse.json({ error: 'Orchestrator not configured' }, { status: 503 });
  if (request.headers.get(ORCHESTRATOR_AUTH_HEADER) !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { tenantId } = await context.params;
  if (!UUID.test(tenantId)) return NextResponse.json({ error: 'Bad tenant' }, { status: 400 });

  let body: { folder?: unknown; documents?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const folderName = String(body.folder ?? '').trim();
  const documents = Array.isArray(body.documents) ? (body.documents as IncomingDocument[]) : [];
  if (!folderName) return NextResponse.json({ error: 'folder is required' }, { status: 400 });
  if (documents.length === 0) return NextResponse.json({ error: 'documents is required' }, { status: 400 });
  // A cap, not a paging scheme. The manual is nine areas plus a spillover; a request for two hundred
  // is a caller bug, and finding that out here is cheaper than finding it out from Google's quota.
  if (documents.length > 40) return NextResponse.json({ error: 'too many documents' }, { status: 400 });
  if (documents.some((d) => !d?.key || !d?.title || typeof d?.html !== 'string')) {
    return NextResponse.json({ error: 'each document needs key, title and html' }, { status: 400 });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return refuse("I can't reach Google just now");

  const supabase = serviceClient();
  const connection = await googleConnectionFor(supabase, tenantId);
  if (!connection) {
    return refuse("no Google account is connected — connect one in Settings and I'll be able to file it");
  }

  // WRITE NEEDS MORE THAN A CONNECTION. `readonly` is a real, granted, working Drive scope that
  // simply cannot create anything, and the failure it produces is a 403 on the first file — which
  // reads as a fault rather than as a permission the owner never gave. Said plainly instead.
  const access = grantedDriveAccess(connection.scopes);
  if (!access) {
    return refuse("your Google account is connected but Drive access wasn't granted — reconnect it in Settings and tick Drive");
  }
  if (access === 'readonly') {
    return refuse(
      "your Drive is connected as read-only, so I can look but I can't file anything. Reconnect it in Settings and I'll be able to put your manual there.",
    );
  }

  let accessToken: string;
  try {
    accessToken = await accessTokenFor(supabase, connection as GoogleConnection, clientId, clientSecret);
  } catch {
    return refuse("I can't reach your Drive just now");
  }

  let folder;
  try {
    folder = await ensureFolder(accessToken, folderName);
  } catch (error) {
    console.error('[record] folder failed:', (error as Error).message);
    return refuse("I couldn't create the folder in your Drive just now");
  }

  // SEQUENTIAL, NOT PARALLEL. Nine concurrent multipart uploads against one token is how a run
  // trips Drive's rate limit, and a partial failure there is the worst outcome: some areas current,
  // some stale, and nothing saying which. One at a time is slower and legible.
  //
  // PER-DOCUMENT OUTCOMES. A failure on one area must not discard the eight that succeeded — their
  // refs are what stop the next run creating duplicates. So each carries its own ok/error and the
  // caller stores what worked.
  const results: Array<{ key: string; ok: boolean; ref?: string; url?: string | null; created?: boolean; error?: string }> = [];
  for (const doc of documents) {
    try {
      const out = await upsertDoc(accessToken, {
        folderId: folder.id,
        title: doc.title,
        html: doc.html,
        existingId: doc.ref ?? null,
      });
      results.push({ key: doc.key, ok: true, ref: out.id, url: out.webViewLink, created: out.created });
    } catch (error) {
      const message = (error as Error).message ?? 'unknown';
      console.error(`[record] ${doc.key} failed:`, message);
      results.push({ key: doc.key, ok: false, error: message.slice(0, 200) });
    }
  }

  const written = results.filter((r) => r.ok).length;

  // `ok` MEANS EVERY DOCUMENT LANDED. A partial run reports false with the count, because "filed" is
  // a claim the owner will act on — he will send someone to the folder — and a manual missing two
  // areas is not a filed manual. The successful refs still come back; they are not the caller's
  // consolation prize, they are what keeps the next run idempotent.
  return NextResponse.json({
    version: CONTRACT_VERSION,
    ok: written === documents.length,
    reason:
      written === documents.length
        ? undefined
        : written === 0
          ? "I couldn't write anything to your Drive"
          : `I filed ${written} of ${documents.length} — the rest didn't go through`,
    folder: { ref: folder.id, url: folder.webViewLink, created: folder.created },
    written,
    total: documents.length,
    results,
  });
}
