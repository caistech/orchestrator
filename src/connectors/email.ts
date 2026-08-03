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
import { formatAbn } from '@caistech/abn-lookup';
import { notifyCaller } from '../callback';
import { renderEmail } from './email-render';
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
  /**
   * True when this tenant has no verified sending address of its own and the mail went out on the
   * portfolio default. Not an error — but it means the recipient saw OUR domain on THEIR business's
   * email, so it must never be something you have to go and check for.
   */
  usedFallbackFrom?: boolean;
  details: Array<{ subject: string; outcome: string; detail?: string }>;
}

interface EffectRow {
  id: string;
  task_id: string;
  kind: string;
  idempotency_key: string;
  request: { to?: string; subject?: string; body?: string; commercial?: boolean };
  /** Joined for tenancy; `payload.kind` also tells the renderer a quote from an ordinary message. */
  tasks?: { tenant_id: string; payload?: { kind?: string } | null } | null;
}

export async function drainEmailOutbox(opts: DrainOptions): Promise<DrainReport> {
  const { supabase, tenantId, apiKey, limit = 25, dryRun = false } = opts;
  const report: DrainReport = { claimed: 0, sent: 0, failed: 0, refused: 0, details: [] };

  // The tenant's own legal identity. Without it there is no lawful footer, so there is no send.
  const { data: tenant } = await supabase
    .from('tenants')
    .select('legal_name, abn, postal_address, reply_email, from_email, name')
    .eq('id', tenantId)
    .maybeSingle();

  if (!tenant?.legal_name || !tenant?.abn || !tenant?.postal_address) {
    throw new Error(
      'tenant sender identity incomplete (legal_name / abn / postal_address). Refusing to send: ' +
        'the alternative is mail with no identification footer, or with OUR ABN on a client\'s email.',
    );
  }

  // WHOSE DOMAIN THE MAIL LEAVES ON.
  //
  // Resolved PER TENANT, falling back to the portfolio default. The footer already carried the
  // tenant's legal identity, so a shared `from` was never unlawful — it was a construction client
  // receiving a Factory2Key quote from an AI company's domain, on the one document where who sent
  // it is the entire point.
  //
  // The fallback is deliberate rather than a gap: a tenant that has not yet verified a domain still
  // sends, because refusing would stop every tenant that has not done DNS — which today is all of
  // them, and DNS usually sits with someone else's provider on someone else's timescale. What must
  // not happen is the fallback being INVISIBLE, so it is reported (`usedFallbackFrom`) and the cron
  // prints it. A quiet fallback is how "we set that up weeks ago" survives being untrue.
  const fromAddress = (tenant.from_email as string | null) || opts.from;
  report.usedFallbackFrom = !tenant.from_email && Boolean(opts.from);

  const sender: SenderIdentity = {
    name: tenant.legal_name,
    email: tenant.reply_email || fromAddress || '',
    // Spaced the way the ABR prints it. Stored as 11 bare digits, which is right for a column and
    // wrong for a document: "ABN 51700805298" reads as a machine value in a footer a client is
    // meant to be able to check.
    abn: formatAbn(tenant.abn as string),
    postal: tenant.postal_address,
  };

  const mailer = createEmailSender({ apiKey, sender, from: fromAddress });

  // WHERE A REPLY GOES.
  //
  // The `from` is the portfolio's verified sending subdomain — it has to be, or Resend rejects the
  // send — and it is a noreply address we own. Without an explicit Reply-To, a client who hits
  // reply on their quote is writing to a mailbox belonging to neither party. Nothing bounces and
  // nobody is told; the reply simply never reaches the business that sent the quote.
  //
  // The tenant's reply_email is already collected and already sits in the footer. It just was never
  // put in the one header that decides where the conversation continues.
  const replyTo = (tenant.reply_email as string | null) || undefined;

  // Only rows for THIS tenant's tasks. effects has no tenant column — it hangs off tasks — so the
  // join is the tenancy boundary and must not be dropped for convenience. `payload` rides along so
  // the renderer knows a quote from a message without a second query per row.
  const { data: candidates, error } = await supabase
    .from('effects')
    .select('id, task_id, kind, idempotency_key, request, tasks!inner(tenant_id, payload)')
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
      // One <p> around the whole body used to be the entire template. HTML collapses whitespace, so
      // every paragraph break and every bullet in a drafted quote arrived as one run-on line.
      const rendered = renderEmail({
        body: row.request?.body ?? '',
        businessName: (tenant.name as string) || (tenant.legal_name as string),
        kind: (row.tasks?.payload as { kind?: string } | null)?.kind ?? null,
        dateLabel: new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }),
      });

      const result = await mailer.send({
        to: realTo,
        subject: subjectOut,
        replyTo,
        html: rendered.html,
        text: rendered.text,
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

      // Tell the caller it actually went. This is the moment Kira can say "that's gone out" —
      // fail-soft, because the mail has already left and losing the notification must not make a
      // successful send look failed.
      await notifyCaller({
        tenantId,
        taskGroupId: row.task_id,
        status: 'done',
        event: 'executed',
        summary: subject,
        detail: { to: realTo, provider_id: result.id ?? null },
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

      await notifyCaller({
        tenantId,
        taskGroupId: row.task_id,
        status: 'failed',
        event: 'failed',
        summary: subject,
        detail: { error: message.slice(0, 200) },
      });

      report.failed += 1;
      report.details.push({ subject, outcome: 'FAILED', detail: message.slice(0, 120) });
    }
  }

  return report;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
