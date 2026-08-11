// The executor binding — the half of the tool register that cannot be config.
//
// config/tools.json says WHAT a tool is. This says WHO PERFORMS IT, and it is a static map on
// purpose. The obvious design puts an "executorModule": "src/connectors/x.ts#fn" string in the JSON
// and imports it dynamically — and it does not work here: a serverless bundle resolves imports at
// BUILD time, so a path that only exists as a string is not bundled, and the tool fails in
// production with a module-not-found rather than in CI. A registry whose failure mode is "works
// locally, missing in prod" is worse than the hardcoded call it replaced.
//
// So the binding is code, the metadata is config, and `npm run check:tools` asserts every
// effect-class entry in the register has a binding here and vice versa. That check is what stops the
// two halves drifting — which is the one real risk of splitting them.

import type { SupabaseClient } from '@supabase/supabase-js';
import { drainEmailOutbox } from '../connectors/email';
import { drainDraftOutbox } from '../connectors/gmail-draft';

/**
 * What every executor is handed. Deliberately narrow: a tenant, a client, and the environment it
 * needs — never the effect rows themselves, because claiming rows is the executor's own job and
 * doing it here would make two executors race over one outbox.
 */
export interface ExecutorContext {
  supabase: SupabaseClient;
  tenantId: string;
  dryRun?: boolean;
  /** Send for real, but to this address. Dev safety valve; the true recipient stays in the subject. */
  redirectTo?: string;
}

/**
 * What an executor reports back.
 *
 * `skipped` is a first-class outcome, not a failure. A tenant part-way through onboarding is an
 * expected state, and reporting it as an error trains everyone to ignore the log — which is how a
 * real error gets missed. The drain already learned this with sender identity.
 */
export interface ExecutorResult {
  sent: number;
  failed: number;
  refused: number;
  skipped?: boolean;
  reason?: string;
  /** Sent on the portfolio default because this tenant has no verified domain of its own. */
  usedFallbackFrom?: boolean;
}

export type Executor = (ctx: ExecutorContext) => Promise<ExecutorResult>;

/**
 * A missing sender identity is routine rather than exceptional, so it is matched on the connector's
 * own message and turned into a skip. Matched NARROWLY on purpose: anything else that throws is a
 * real error and must not be quietly filed as "not onboarded yet".
 */
function isIdentityGap(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('tenant sender identity incomplete');
}

const sendEmail: Executor = async ({ supabase, tenantId, dryRun, redirectTo }) => {
  const apiKey = process.env.RESEND_API_KEY;
  // Reported as a skip with a reason rather than thrown: an unset key is an operator gap, and one
  // tenant's run must not read as that tenant's failure.
  if (!apiKey) return { sent: 0, failed: 0, refused: 0, skipped: true, reason: 'RESEND_API_KEY unset' };

  try {
    const report = await drainEmailOutbox({
      supabase,
      tenantId,
      apiKey,
      from: process.env.EMAIL_FROM,
      unsubscribeBaseUrl: process.env.UNSUBSCRIBE_BASE_URL,
      redirectTo: redirectTo ?? process.env.EMAIL_REDIRECT_TO,
      dryRun,
    });
    return {
      sent: report.sent,
      failed: report.failed,
      refused: report.refused,
      usedFallbackFrom: report.usedFallbackFrom,
    };
  } catch (caught) {
    if (isIdentityGap(caught)) {
      return {
        sent: 0,
        failed: 0,
        refused: 0,
        skipped: true,
        reason: 'no sender identity yet — the owner has not finished setting up their business',
      };
    }
    throw caught;
  }
};

/**
 * Put the prepared email in the owner's OWN Gmail drafts, for him to review and send himself.
 *
 * A separate kind from `email.send` on purpose. They differ in destination, in who the recipient sees
 * it from, and — the part that matters — in what they can do wrong: a draft harms nobody, so it
 * carries no approval gate, while a send keeps one. Two kinds, two gates, enforced by this drain
 * rather than by anything that reasons.
 */
const draftEmail: Executor = async ({ supabase, tenantId, dryRun }) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { sent: 0, failed: 0, refused: 0, skipped: true, reason: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET unset' };
  }

  const report = await drainDraftOutbox({ supabase, tenantId, clientId, clientSecret, dryRun });
  return {
    // `sent` on this executor means "written into his drafts", never "left the building".
    sent: report.drafted,
    failed: report.failed,
    refused: 0,
    skipped: report.skipped,
    reason: report.reason,
  };
};

/** kind → executor. The key MUST match a `class: "effect"` entry in config/tools.json. */
export const EXECUTORS: Record<string, Executor> = {
  'email.send': sendEmail,
  'email.draft': draftEmail,
};

export function executorFor(kind: string): Executor | null {
  return EXECUTORS[kind] ?? null;
}

export function boundKinds(): string[] {
  return Object.keys(EXECUTORS);
}
