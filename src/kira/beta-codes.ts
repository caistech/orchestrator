// Beta-code domain logic for the Kira→Orchestrator boundary.
//
// WHY THIS LIVES HERE. The Group B remediation moves Kira's service-role database access into this
// service (see lib/kira-supabase.ts). The beta-code table operations are the FIRST migration: they
// are single-table, atomicity survives the network hop because the guarded UPDATE runs wholly on
// this side, and the caller is pre-authentication by definition — the most restricted capability.
//
// TWIN WARNING. `normaliseBetaCode` and `checkBetaCode` are ported from Kira's
// lib/billing/beta-codes.ts, where the full reasoning comments live. They MUST stay behaviourally
// identical: Kira's signup flow shows messages keyed off the rejection reasons produced here, and a
// divergence means a tester is told something untrue about his own invitation. If you change one
// side, change both in the same change-set.
//
// THE REASON IS FOR US, NOT FOR THE VISITOR (carried over verbatim from Kira): this endpoint
// deliberately answers a single indistinguishable reason enum for every rejection — telling an
// anonymous caller the difference between "no such code" and "already used" confirms which codes
// exist. Kira's routes map every reason to ONE public sentence; the distinction is preserved only
// in logs.

export type BetaCodeRejection = 'unknown' | 'redeemed' | 'revoked' | 'expired';

/** The shape of a beta_codes row this module reads. Dates are ISO strings from Postgres. */
export interface BetaCodeRow {
  code: string;
  email: string;
  expires_at: string;
  redeemed_at: string | null;
  revoked_at: string | null;
}

/**
 * Normalise a pasted code: uppercase, strip every non-alphanumeric.
 *
 * Whitespace, hyphens and en-dashes must never turn a valid code into a rejection — a tester whose
 * paste carried a trailing space is indistinguishable from one holding a dead code, which is the
 * exact failure the codes-not-links decision exists to avoid. Ported verbatim from Kira.
 */
export function normaliseBetaCode(raw: string): string {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Is this row usable right now — and if not, WHY.
 *
 * Pure and separately exported so every branch can be tested without minting anything. Ported
 * verbatim from Kira (see the twin warning above).
 */
export function checkBetaCode(row: BetaCodeRow | null, now: Date): BetaCodeRejection | null {
  if (!row) return 'unknown';
  if (row.revoked_at) return 'revoked';
  if (row.redeemed_at) return 'redeemed';
  if (new Date(row.expires_at).getTime() <= now.getTime()) return 'expired';
  return null;
}
