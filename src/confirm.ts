// Detection versus decision — the rule that keeps a projection safe.
//
//   > Sweep the projection to find candidates. Confirm against the system of record before emitting
//   > an effect.                                                        (ORCHESTRATOR_SPEC §9)
//
// A projection is stale the moment it is written. The failure that creates is not abstract: an
// invoice the client paid this morning is still 34 days overdue in our copy, and chasing it is the
// most embarrassing thing this system can do — it tells the customer we are not paying attention,
// on the one topic where they are.
//
// So the sweep is DETECTION and this is DECISION. It costs one API call at exactly the point where
// being wrong is expensive, and it removes the whole class.
//
// Where the source cannot be reached, the task does NOT proceed — it fails to the review queue with
// the reason. Degrade, don't fake (DATA_STANDARD R4). Treating unreachable as "probably fine" would
// give back the entire guarantee the moment a vendor has an outage.

import type { SweepEntity } from './rules';

export interface ConfirmResult {
  /** True when the source agrees the trigger still holds and an effect may be emitted. */
  ok: boolean;
  reason?: string;
  /** True when we could not reach the source at all — distinct from "the source said no". */
  unreachable?: boolean;
}

export interface SourceConfirmer {
  /** The source system this confirms against ('xero', 'simpro', …). */
  system: string;
  confirm(entity: SweepEntity): Promise<ConfirmResult>;
}

/**
 * The development confirmer.
 *
 * Reads the truth the seed plants in `attributes._dev_source_truth`, so detection-versus-decision is
 * exercisable before a single real connector exists. This is not a stand-in for the Xero connector —
 * it is how the MECHANISM is proven, and it stays useful afterwards because a real ledger cannot be
 * asked to contain an invoice that is 34 days overdue in our copy and settled at source on demand.
 */
export class DevSourceConfirmer implements SourceConfirmer {
  readonly system = '*';

  async confirm(entity: SweepEntity): Promise<ConfirmResult> {
    const truth = entity.attributes?._dev_source_truth;

    if (truth === 'PAID') {
      return { ok: false, reason: 'source of record reports PAID — projection was stale' };
    }
    if (truth === 'UNREACHABLE') {
      return { ok: false, unreachable: true, reason: 'source system could not be reached' };
    }
    return { ok: true };
  }
}

/** Confirmers by source system. A rule whose entity has no confirmer falls through to `fallback`. */
export function confirmerFor(
  entity: SweepEntity,
  registry: Map<string, SourceConfirmer>,
  fallback: SourceConfirmer,
): SourceConfirmer {
  return (entity.source_system && registry.get(entity.source_system)) || fallback;
}
