// The trust ratchet — outcome-evidence promotion of delegation bands.
//
// AGENTIC_NETWORK.md §5: "Ratchet input = outcome evidence (no downstream rework within window)
// not approval count."
//
// WHY THIS EXISTS. The original ratchet proposal counted consecutive un-edited approvals — but
// that measures whether the OWNER read the queue, not whether the AGENT was correct. An owner
// who is too busy to read (the exact owner we serve) auto-promotes the fastest, and corrections
// arrive AFTER send (the client calls about the $60k quote), when no edit signal exists.
//
// So this ratchet runs on OUTCOME EVIDENCE: did the task complete without downstream complaint
// or rework within a defined window? That is the signal that the agent's output was correct
// enough to deserve a wider leash.
//
// The ratchet is REVERSIBLE: one material bad outcome strips the promoted level for that action.
// It is CAPPED: the `reserved` list never ratchets, and spend ceilings are owner-set and never
// removed. A tenant who has not set a delegation policy gets no ratchet — silence means "ask
// about everything", which is the safe default.
//
// This is a PURE computation module — no DB writes. The caller (run-agents.ts) reads the
// evidence, calls these functions, and writes the result to delegation_policy if appropriate.
// That separation keeps the ratchet testable without a live database.

import type { Band, DelegationPolicy, GateDecision } from '../gate';

// ── Types ─────────────────────────────────────────────────────────────────────────────────────

/** The ordered progression of bands from most restrictive to least. */
const BAND_ORDER: Band[] = ['reserved', 'approve_before_start', 'approve_before_send', 'notify', 'auto'];

function bandIndex(band: Band): number {
  return BAND_ORDER.indexOf(band);
}

/** One outcome record: did this task succeed or fail? */
export interface OutcomeRecord {
  taskId: string;
  tenantId: string;
  action: string;
  /** ISO timestamp of task completion. */
  completedAt: string;
  /** true = success (no complaint within window), false = failure (complaint, rework, SLA breach). */
  success: boolean;
  /** Optional reason for failure — what went wrong. */
  failureReason?: string;
  /** The band the gate resolved to when this task was dispatched. */
  resolvedBand: Band;
  /** AUD value of the action, if applicable. */
  spend?: number;
}

/** The ratchet's recommendation for one (tenant, action) pair. */
export interface RatchetDecision {
  tenantId: string;
  action: string;
  currentBand: Band;
  recommendedBand: Band;
  /** The band the gate resolves to AFTER ratchet adjustments. */
  effectiveBand: Band;
  /** Why this recommendation. */
  reason: string;
  /** Number of successful outcomes in the evaluation window. */
  successCount: number;
  /** Number of failures in the evaluation window. */
  failureCount: number;
  /** Whether this action is in the reserved list (never ratchets). */
  reserved: boolean;
}

// ── Core ratchet logic ────────────────────────────────────────────────────────────────────────

/**
 * Evaluate the ratchet for one (tenant, action) pair.
 *
 * The promotion logic:
 *   1. `reserved` actions NEVER ratchet — checked first, unconditionally.
 *   2. Count successes and failures within the evaluation window.
 *   3. If there are ANY failures, STRIP one level (demote). One bad outcome strips; the owner
 *      earns trust back with a clean streak, same as the original design.
 *   4. If there are ZERO failures and the success count exceeds the threshold, PROMOTE one level.
 *   5. Never promote past `notify` for spend-bearing actions without an explicit owner override.
 *
 * The caller must provide the current delegation_policy for this tenant — the ratchet does not
 * read the DB. This keeps it pure and testable.
 */
export function evaluateRatchet(
  policy: DelegationPolicy,
  outcomes: OutcomeRecord[],
  opts: {
    /** Minimum consecutive successes before promotion. Default: 5. */
    promotionThreshold?: number;
    /** The current band for this action (resolved from the policy). */
  currentBand: Band;
}): RatchetDecision {
  const { currentBand } = opts;
  const promotionThreshold = opts.promotionThreshold ?? 5;
  const action = outcomes[0]?.action ?? '';
  const tenantId = outcomes[0]?.tenantId ?? '';

  // ── Reserved check ──────────────────────────────────────────────────────────────────────────
  //
  // Reserved actions are NEVER delegable, whatever the bands say. Supplier bank-detail change
  // is the sharpest case: the entire attack is convincing someone it is routine.
  const isReserved = policy.reserved?.some((flow) =>
    outcomes.some((o) => o.action === flow || o.action.startsWith(`${flow}.`)),
  ) ?? false;

  if (isReserved || currentBand === 'reserved') {
    return {
      tenantId,
      action,
      currentBand,
      recommendedBand: 'reserved',
      effectiveBand: 'reserved',
      reason: 'reserved — never delegated at any authority level',
      successCount: 0,
      failureCount: 0,
      reserved: true,
    };
  }

  // ── Count outcomes ──────────────────────────────────────────────────────────────────────────
  const successes = outcomes.filter((o) => o.success).length;
  const failures = outcomes.filter((o) => !o.success).length;

  // ── Failure → demote ────────────────────────────────────────────────────────────────────────
  //
  // One material bad outcome strips the promoted level. The owner earns trust back with a clean
  // streak — same shape as the original design, but driven by outcomes not approvals.
  if (failures > 0) {
    const currentIdx = bandIndex(currentBand);
    // Cannot demote below 'approve_before_send' — the natural floor for an unconfigured action.
    // Demoting is MOVING TOWARD more restriction, so we step back (-1) toward `reserved`.
    const floorIdx = bandIndex('approve_before_send');
    const newIdx = Math.max(currentIdx - 1, floorIdx); // more restrictive
    const newBand = BAND_ORDER[newIdx] ?? 'approve_before_send';

    return {
      tenantId,
      action,
      currentBand,
      recommendedBand: newBand,
      effectiveBand: newBand,
      reason: `${failures} failure(s) in window — stripping from ${currentBand} to ${newBand}`,
      successCount: successes,
      failureCount: failures,
      reserved: false,
    };
  }

  // ── Success → promote ───────────────────────────────────────────────────────────────────────
  //
  // Zero failures and enough successes: widen the leash by one level. Promotion is MOVING AWAY
  // from `reserved` (+1 = LESS restrictive). The ceiling is 'notify' — auto requires an explicit
  // owner override, and spend-bearing actions need a ceiling the owner has set.
  if (successes >= promotionThreshold) {
    const currentIdx = bandIndex(currentBand);
    const ceilingIdx = bandIndex('notify');
    const newIdx = Math.min(currentIdx + 1, ceilingIdx); // less restrictive
    const newBand = BAND_ORDER[newIdx] ?? currentBand;

    if (newBand === currentBand) {
      return {
        tenantId,
        action,
        currentBand,
        recommendedBand: currentBand,
        effectiveBand: currentBand,
        reason: `already at ceiling (${currentBand}) — ${successes} successes, no promotion possible`,
        successCount: successes,
        failureCount: failures,
        reserved: false,
      };
    }

    return {
      tenantId,
      action,
      currentBand,
      recommendedBand: newBand,
      effectiveBand: newBand,
      reason: `${successes} consecutive successes (threshold: ${promotionThreshold}) — promoting from ${currentBand} to ${newBand}`,
      successCount: successes,
      failureCount: failures,
      reserved: false,
    };
  }

  // ── Not enough data ─────────────────────────────────────────────────────────────────────────
  return {
    tenantId,
    action,
    currentBand,
    recommendedBand: currentBand,
    effectiveBand: currentBand,
    reason: `${successes} successes, ${failures} failures — below promotion threshold (${promotionThreshold})`,
    successCount: successes,
    failureCount: failures,
    reserved: false,
  };
}

/**
 * Build the updated delegation_policy bands after applying a ratchet decision.
 *
 * This is the "write" side: given the current policy and a decision, produce the new policy
 * with the action moved to the recommended band. The caller persists this to the DB.
 *
 * Returns null when the decision does not change anything (same band).
 */
export function applyRatchetToPolicy(
  policy: DelegationPolicy,
  decision: RatchetDecision,
): DelegationPolicy | null {
  if (decision.recommendedBand === decision.currentBand) return null;
  if (decision.reserved) return null;

  // Deep-clone the policy to avoid mutation.
  const updated: DelegationPolicy = JSON.parse(JSON.stringify(policy));
  const bands = updated.bands ?? {};

  // Remove the action from its current band.
  for (const bandKey of ['notify', 'approve_before_send', 'approve_before_start'] as const) {
    const band = bands[bandKey];
    if (band?.actions) {
      band.actions = band.actions.filter((a) => a !== decision.action);
    }
  }

  // Add the action to the new band.
  const targetBand = decision.recommendedBand;
  if (targetBand === 'auto') {
    // 'auto' is the default when no band matches — removing from all bands is sufficient.
    // The gate resolves to 'approve_before_send' for unknown actions, so removing it from
    // all bands means it falls through to the default. This is correct for ratchet promotions:
    // auto means "the gate did not find this action in any restrictive band".
  } else if (targetBand === 'notify') {
    if (!bands.notify) bands.notify = { actions: [] };
    if (!bands.notify.actions) bands.notify.actions = [];
    bands.notify.actions.push(decision.action);
  } else if (targetBand === 'approve_before_send') {
    if (!bands.approve_before_send) bands.approve_before_send = { actions: [] };
    if (!bands.approve_before_send.actions) bands.approve_before_send.actions = [];
    bands.approve_before_send.actions.push(decision.action);
  } else if (targetBand === 'approve_before_start') {
    if (!bands.approve_before_start) bands.approve_before_start = { actions: [] };
    if (!bands.approve_before_start.actions) bands.approve_before_start.actions = [];
    bands.approve_before_start.actions.push(decision.action);
  }

  updated.bands = bands;
  return updated;
}
