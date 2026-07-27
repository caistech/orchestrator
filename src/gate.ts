// The delegation gate.
//
// TASK_REGISTRY §7: gates are a DELEGATION SCHEDULE, not a per-flow setting. One tenant policy
// governs all 140 flows, and it resolves from properties of the ACTION — consequence, spend,
// counterparty — never from the identity of the flow. A $60 top-up and a $60k order are the same
// flow and must gate differently, which is the single clearest argument against per-flow settings.
//
// The failure this exists to prevent is not under-gating, it is OVER-gating. Applied literally,
// "nothing that leaves the business goes without approval" catches ~35 flows, several firing daily.
// The owner stops reading the queue inside a week, and an unread queue is WORSE than no queue,
// because it launders unreviewed output as approved.

export type Band = 'auto' | 'notify' | 'approve_before_send' | 'approve_before_start' | 'reserved';

export interface DelegationPolicy {
  bands: {
    notify?: { actions?: string[] };
    approve_before_send?: { actions?: string[] };
    approve_before_start?: { actions?: string[]; spend_threshold_aud?: number };
  };
  /** Registry flow ids that are NEVER delegable, whatever the bands say. */
  reserved: string[];
}

export interface GateInput {
  flow: string;
  action: string;
  /** AUD leaving the business, when the action spends. Null when nothing is spent. */
  spend: number | null;
}

export interface GateDecision {
  band: Band;
  /** True when a human must decide before anything is emitted. */
  holds: boolean;
  why: string;
}

export function resolveBand(policy: DelegationPolicy, input: GateInput): GateDecision {
  // RESERVED FIRST, and unconditionally. These are never reachable by a limit that widens with
  // trust — supplier bank-detail change is the sharpest case, because the entire attack is
  // convincing someone that it is routine. Checking this first means no later rule can undercut it.
  if (policy.reserved?.includes(input.flow)) {
    return { band: 'reserved', holds: true, why: 'reserved action — never delegated at any authority level' };
  }

  const b = policy.bands ?? {};

  // Spend gates before send gates: money leaving is the higher consequence, and an action can be
  // both (a purchase order is sent AND spends).
  if (b.approve_before_start?.actions?.includes(input.action)) {
    const threshold = b.approve_before_start.spend_threshold_aud;
    if (threshold === undefined || (input.spend ?? 0) >= threshold) {
      return {
        band: 'approve_before_start',
        holds: true,
        why: threshold === undefined
          ? 'money leaves'
          : `spend ${input.spend ?? 0} ≥ threshold ${threshold}`,
      };
    }
    // Under the threshold the delegation is real: it proceeds without asking. This branch is the
    // whole point of banding by spend — without it, every $60 reorder queues behind a human.
    return { band: 'auto', holds: false, why: `spend ${input.spend ?? 0} < threshold ${threshold}` };
  }

  if (b.approve_before_send?.actions?.includes(input.action)) {
    return { band: 'approve_before_send', holds: true, why: 'reaches a customer and commits us' };
  }

  if (b.notify?.actions?.includes(input.action)) {
    return { band: 'notify', holds: false, why: 'no money, no commitment, reversible' };
  }

  // UNKNOWN ACTIONS HOLD. An action nobody has banded is one nobody has thought about, and the safe
  // default for "we have not decided" is to ask. The alternative — defaulting to auto — means every
  // new flow ships silently self-authorised.
  return { band: 'approve_before_send', holds: true, why: 'action not present in any band — defaulting to ask' };
}
