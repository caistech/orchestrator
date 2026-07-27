// The email connector — drains the outbox, and is the first thing here that changes the world.
//
// Everything left of this file is a decision that can be taken back. Everything from here is an
// email a customer has already read, which is why the shape is deliberately cautious:
//
//   claim (pending → sending) → send → record (sent | failed)
//
// The claim is a conditional update only one worker can win. Mark-then-send double-sends on a crash
// between the two; send-then-mark double-sends on a concurrent run. Claiming first narrows the
// window to the send itself, and a row stuck in 'sending' is VISIBLE — it means a worker died and we
// do not know whether the mail went out. It is deliberately not auto-retried, because "probably did
// not send" is not a good enough reason to chase someone twice.
//
// COMPLIANCE IS NOT OPTIONAL AND IT IS NOT OURS.
//
// The sender is the TENANT — a plumbing business chasing its own customer — so the Spam Act
// identification footer carries THEIR name and ABN, never Corporate AI Solutions'. Putting our ABN
// on a client's debt-chase is the white-label failure PRODUCT_STANDARDS §9 exists to prevent, and it
// is worse than a missing footer because it is confidently wrong.
//
// Commercial mail additionally requires a working unsubscribe. We do not yet host one, so commercial
// sends are REFUSED here rather than sent without it. That is the whole point of the split: the
// transactional flows (a debt chase, a quote follow-up, an expiry notice) can go today; the
// marketing ones (reawaken a quiet client, chase a cold lead) wait for the unsubscribe route.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEmailSender } from '@caistech/email-send';
import type { SenderIdentity } from '@caistech/email-compliance';

export interface DrainOptions {
  supabase: SupabaseClient;
  tenantId: string;
  apiKey: string;
  /** Verified sending domain. Must be a domain Resend has verified, or every send silently fails. */
  from?: string;
  /**
   * Dev safety valve: send for real, but to this address instead of the seeded recipient. The seed
   * uses @example.invalid addresses on purpose (unroutable), so without this the transport can only
   * ever be proven by a bounce. The true recipient is preserved in the subject so the redirect is
   * obvious in the inbox rather than confusing.
   */
  redirectTo?: string;
  /** Present only once an unsubscribe route is hosted. Its absence is what blocks commercial mail. */
  unsubscribeBaseUrl?: string;
  limit?: number;
  dryRun?: boolean;
}

export interface DrainReport {
  claimed: number;
  sent: number;
  failed: number;
  refused: number;
  details: Array<{ subject: string; outcome: string; detail?: string }>;
}

interface EffectRow {
  id: string;
  task_id: string;
  kind: string;
  idempotency_key: string;
  request: { to?: string; subject?: string; body?: string; commercial?: boolean };
}

export async function drainEmailOutbox(opts: DrainOptions): Promise<DrainReport> {
  const { supabase, tenantId, apiKey, limit = 25, dryRun = false } = opts;
  const report: DrainReport = { claimed: 0, sent: 0, failed: 0, refused: 0, details: [] };

  // The tenant's own legal identity. Without it there is no lawful footer, so there is no send.
  const { data: tenant } = await supabase
    .from('tenants')
    .select('legal_name, abn, postal_address, reply_email, name')
    .eq('id', tenantId)
    .maybeSingle();

  if (!tenant?.legal_name || !tenant?.abn || !tenant?.postal_address) {
    throw new Error(
      'tenant sender identity incomplete (legal_name / abn / postal_address). Refusing to send: ' +
        'the alternative is mail with no identification footer, or with OUR ABN on a client\'s email.',
    );
  }

  const sender: SenderIdentity = {
    name: tenant.legal_name,
    email: tenant.reply_email || opts.from || '',
    abn: tenant.abn,
    postal: tenant.postal_address,
  };

  const mailer = createEmailSender({ apiKey, sender, from: opts.from });

  // Only rows for THIS tenant's tasks. effects has no tenant column — it hangs off tasks — so the
  // join is the tenancy boundary and must not be dropped for convenience.
  const { data: candidates, error } = await supabase
    .from('effects')
    .select('id, task_id, kind, idempotency_key, request, tasks!inner(tenant_id)')
    .eq('status', 'pending')
    .eq('kind', 'email.send')
    .eq('tasks.tenant_id', tenantId)
    .limit(limit);
  if (error) throw new Error(`outbox read failed: ${error.message}`);

  for (const row of (candidates ?? []) as unknown as EffectRow[]) {
    const to = row.request?.to;
    const subject = row.request?.subject ?? '(no subject)';
    const commercial = row.request?.commercial === true;

    // ── REFUSE before claiming ────────────────────────────────────────────────────────────────
    // A refusal is not a failure of this send, it is a statement that the send must not happen yet.
    // Leaving the row 'pending' means it goes out the moment the blocker is removed, with no
    // re-derivation and no lost work.
    if (commercial && !opts.unsubscribeBaseUrl) {
      report.refused += 1;
      report.details.push({
        subject,
        outcome: 'REFUSED',
        detail: 'commercial mail requires a working unsubscribe; none is hosted yet',
      });
      continue;
    }
    if (!to) {
      report.refused += 1;
      report.details.push({ subject, outcome: 'REFUSED', detail: 'no recipient on the effect' });
      continue;
    }

    if (dryRun) {
      report.details.push({
        subject,
        outcome: 'WOULD SEND',
        detail: `${commercial ? 'commercial' : 'transactional'} → ${opts.redirectTo ?? to}`,
      });
      continue;
    }

    // ── CLAIM ─────────────────────────────────────────────────────────────────────────────────
    const { data: claimed } = await supabase
      .from('effects')
      .update({ status: 'sending', claimed_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'pending')          // ← only one worker wins this
      .select('id')
      .maybeSingle();
    if (!claimed) continue;             // someone else took it
    report.claimed += 1;

    // ── SEND ──────────────────────────────────────────────────────────────────────────────────
    try {
      const realTo = opts.redirectTo ?? to;
      const subjectOut = opts.redirectTo ? `[to: ${to}] ${subject}` : subject;
      const result = await mailer.send({
        to: realTo,
        subject: subjectOut,
        html: `<p>${escapeHtml(row.request?.body ?? '')}</p>`,
        text: row.request?.body ?? '',
        compliance: commercial
          ? { unsubscribeUrl: `${opts.unsubscribeBaseUrl}?e=${encodeURIComponent(to)}`, reason: 'inferred' }
          : { transactional: true },
      });

      await supabase
        .from('effects')
        .update({ status: 'sent', response: { id: result.id, to: realTo }, completed_at: new Date().toISOString() })
        .eq('id', row.id);
      await supabase.from('tasks').update({ status: 'done' }).eq('id', row.task_id);
      await supabase.from('task_events').insert({
        task_id: row.task_id, event: 'executed', detail: { provider_id: result.id, to: realTo },
      });

      report.sent += 1;
      report.details.push({ subject, outcome: 'SENT', detail: `id ${result.id ?? '(none)'} → ${realTo}` });
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      // Surface Resend's own words. "domain is not verified" is unrecognisable behind a generic
      // failure, and it is the single most common reason portfolio mail goes nowhere.
      await supabase
        .from('effects')
        .update({ status: 'failed', error: message, attempts: 1, completed_at: new Date().toISOString() })
        .eq('id', row.id);
      await supabase.from('tasks').update({ status: 'failed' }).eq('id', row.task_id);
      await supabase.from('task_events').insert({ task_id: row.task_id, event: 'failed', detail: { error: message } });

      report.failed += 1;
      report.details.push({ subject, outcome: 'FAILED', detail: message.slice(0, 120) });
    }
  }

  return report;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
