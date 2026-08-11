// Put a prepared email into the OWNER'S OWN Gmail drafts. Never send it.
//
// WHY THIS EXISTS. Asked three times in one call on 2026-08-11 — "just put it in drafts in Gmail" —
// and Kira answered "I'll save the draft in your Gmail for you to review." She could not: the Google
// connection requested Drive and Contacts and no Gmail scope at all, so nothing was ever written and
// the owner was told it had been. A capability claimed and absent is worse than one absent, because
// he goes looking for it.
//
// IT IS ALSO THE BETTER PRODUCT. `email.send` goes out through Resend from a noreply address we own,
// with his reply-to in the header. A draft in HIS mailbox is sent BY HIM: it comes from his real
// address, lands in his sent items, threads with the client's earlier mail, and carries no
// third-party sending domain. For an owner who has done business by email for thirty years that is
// not a smaller feature than sending — it is the one he keeps asking for.
//
// ⚠️ THE SCOPE IS WIDER THAN THE JOB, AND THERE IS NO WAY AROUND IT. `gmail.compose` is the narrowest
// Google scope that can create a draft, and it also permits sending messages and drafts. Google
// publishes no draft-only scope. So the credential in this module CAN send, and the only thing that
// stops it is this module. That is stated rather than designed around.
//
// WHICH IS WHY THIS FILE IS SHAPED LIKE `xero-read.ts`: one operation, the URL and the verb written
// out at the single call site, no parameter that could carry `messages/send`, and a test that fails
// if that path ever appears in this module. A drafting module that can be handed an endpoint is a
// sending module waiting for a careless call site.
//
// The reasoning layer never holds this. Kira emits an `email.draft` effect and has no Gmail tool, no
// token, and no way to acquire one — src/tools/register.ts: "effect tools are NOT in a handler's tool
// set at all". The partition is intent-versus-execution, not agent-versus-agent, because three agents
// sharing one compose-scoped token would all be able to send.

import type { SupabaseClient } from '@supabase/supabase-js';

import { accessTokenFor, googleConnectionFor } from './google';

/** The one Gmail endpoint this module may touch. Not a parameter, and not built from one. */
const DRAFTS_CREATE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/drafts';

export interface DraftRequest {
  to?: string | string[];
  cc?: string | string[];
  subject?: string;
  body?: string;
}

export interface DraftReport {
  drafted: number;
  failed: number;
  skipped?: boolean;
  reason?: string;
}

interface EffectRow {
  id: string;
  task_id: string;
  request: DraftRequest | null;
  tasks: { tenant_id: string } | null;
}

const asList = (v: string | string[] | undefined): string =>
  (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean).join(', ');

/**
 * RFC 5322 message, base64url encoded — what the Gmail API wants.
 *
 * Deliberately plain text. HTML would need a MIME boundary and quoted-printable handling, and a draft
 * the owner is about to edit in his own client gains nothing from markup he did not write.
 *
 * The subject is encoded rather than passed through: a non-ASCII character in a raw header is not
 * merely ugly, it makes the header invalid, and the failure surfaces as a rejected draft with no
 * explanation of which field was wrong.
 */
export function buildRawMessage(req: DraftRequest): string {
  const encodeHeader = (s: string) =>
    /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

  const headers = [
    asList(req.to) ? `To: ${asList(req.to)}` : null,
    asList(req.cc) ? `Cc: ${asList(req.cc)}` : null,
    `Subject: ${encodeHeader(req.subject ?? '')}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
  ].filter(Boolean);

  const message = `${headers.join('\r\n')}\r\n\r\n${req.body ?? ''}`;
  return Buffer.from(message, 'utf8').toString('base64url');
}

/**
 * Perform every pending `email.draft` effect for one tenant.
 *
 * Mirrors drainEmailOutbox: the tenancy boundary is the join through `tasks`, because `effects` has
 * no tenant column and dropping that join for convenience is how one owner's work reaches another's
 * account.
 */
export async function drainDraftOutbox(opts: {
  supabase: SupabaseClient;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  limit?: number;
  dryRun?: boolean;
}): Promise<DraftReport> {
  const { supabase, tenantId, clientId, clientSecret, limit = 20, dryRun } = opts;

  const connection = await googleConnectionFor(supabase, tenantId);
  if (!connection) {
    // A skip, not a failure. An owner who has not connected Google is an expected state, and
    // reporting it as an error is how real errors get ignored.
    return { drafted: 0, failed: 0, skipped: true, reason: 'no Google connection for this tenant' };
  }
  if (!hasGmailScope(connection.scopes)) {
    // The specific, actionable version. "Google is connected" and "Google is connected with Gmail"
    // are different facts, and an owner who connected before this shipped is in the second state.
    return {
      drafted: 0,
      failed: 0,
      skipped: true,
      reason: 'the Google connection predates Gmail access — the owner needs to reconnect',
    };
  }

  const { data: rows, error } = await supabase
    .from('effects')
    .select('id, task_id, request, tasks!inner(tenant_id)')
    .eq('status', 'pending')
    .eq('kind', 'email.draft')
    .eq('tasks.tenant_id', tenantId)
    .limit(limit);
  if (error) throw new Error(`draft outbox read failed: ${error.message}`);

  const report: DraftReport = { drafted: 0, failed: 0 };
  if (!rows?.length) return report;

  const accessToken = await accessTokenFor(supabase, connection, clientId, clientSecret);

  for (const row of rows as unknown as EffectRow[]) {
    const req = row.request ?? {};
    if (!asList(req.to)) {
      await supabase
        .from('effects')
        .update({ status: 'failed', last_error: 'no recipient on the draft request' })
        .eq('id', row.id);
      report.failed += 1;
      continue;
    }

    if (dryRun) {
      report.drafted += 1;
      continue;
    }

    // The verb and the URL are written here, once, as literals. See the header.
    const res = await fetch(DRAFTS_CREATE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { raw: buildRawMessage(req) } }),
    });

    if (!res.ok) {
      // Google's own words are kept. "Insufficient Permission" and "Invalid To header" need
      // different responses from a human, and a generic failure hides which one happened.
      const detail = (await res.text()).slice(0, 300);
      await supabase
        .from('effects')
        .update({ status: 'failed', last_error: `gmail drafts.create ${res.status}: ${detail}` })
        .eq('id', row.id);
      report.failed += 1;
      continue;
    }

    const created = (await res.json()) as { id?: string; message?: { id?: string } };
    await supabase
      .from('effects')
      .update({
        status: 'done',
        completed_at: new Date().toISOString(),
        result: { draft_id: created.id ?? null, message_id: created.message?.id ?? null },
      })
      .eq('id', row.id);
    report.drafted += 1;
  }

  return report;
}

/** Did the owner actually grant Gmail? Read back, never assumed — same rule as grantedContactsAccess. */
export function hasGmailScope(scope: string | undefined | null): boolean {
  return (scope ?? '').split(/\s+/).includes(GMAIL_DRAFT_SCOPE);
}

export const GMAIL_DRAFT_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';
