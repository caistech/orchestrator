// The trust ratchet — outcome-evidence promotion of delegation bands.
//
// The design decision behind these tests is in AGENTIC_NETWORK.md §5: the ratchet runs on
// OUTCOME EVIDENCE (no downstream complaint/rework), not on approval counts. An owner too busy
// to read the queue would otherwise auto-promote the fastest — the exact owner we serve.

import { describe, it, expect } from 'vitest';

import { evaluateRatchet, applyRatchetToPolicy, type OutcomeRecord } from './ratchet';
import type { DelegationPolicy } from '../gate';

const POLICY: DelegationPolicy = {
  bands: {
    approve_before_send: { actions: ['email.send'] },
  },
  reserved: ['supplier.bank_detail'],
};

function outcomesOver(
  action: string,
  tenantId: string,
  count: number,
  opts: { success?: boolean; resolvedBand?: 'approve_before_send' } = {},
): OutcomeRecord[] {
  const success = opts.success ?? true;
  return Array.from({ length: count }, (_, i) => ({
    taskId: `task-${i}`,
    tenantId,
    action,
    completedAt: '2026-09-16T00:00:00Z',
    success,
    resolvedBand: opts.resolvedBand ?? 'approve_before_send',
  }));
}

describe('evaluateRatchet', () => {
  it('never promotes a reserved action', () => {
    const decision = evaluateRatchet(POLICY, outcomesOver('supplier.bank_detail', 't1', 50), {
      currentBand: 'approve_before_start',
    });
    expect(decision.reserved).toBe(true);
    expect(decision.effectiveBand).toBe('reserved');
  });

  it('does not raise an action below its trust threshold', () => {
    const decision = evaluateRatchet(POLICY, outcomesOver('email.send', 't1', 2), {
      currentBand: 'approve_before_send',
    });
    expect(decision.successCount).toBe(2);
    expect(decision.effectiveBand).toBe('approve_before_send');
    expect(decision.recommendedBand).toBe('approve_before_send');
  });

  it('promotes an action after enough clean outcomes', () => {
    const decision = evaluateRatchet(POLICY, outcomesOver('email.send', 't1', 6), {
      currentBand: 'approve_before_send',
    });
    expect(decision.successCount).toBe(6);
    expect(decision.failureCount).toBe(0);
    // approve_before_send → notify (one step less restrictive)
    expect(decision.effectiveBand).toBe('notify');
  });

  it('strips a level on any failure', () => {
    const outcomes = outcomesOver('email.send', 't1', 3, { success: true });
    outcomes[2] = { ...outcomes[2], success: false, failureReason: 'client said the figure was wrong' };
    const decision = evaluateRatchet(POLICY, outcomes, { currentBand: 'notify' });
    expect(decision.failureCount).toBe(1);
    // notify → approve_before_send (one step more restrictive)
    expect(decision.effectiveBand).toBe('approve_before_send');
  });

  it('never promotes past the ceiling (notify) without overrides', () => {
    const decision = evaluateRatchet(POLICY, outcomesOver('email.send', 't1', 60), {
      currentBand: 'notify',
    });
    expect(decision.effectiveBand).toBe('notify');
  });
});

describe('applyRatchetToPolicy', () => {
  it('returns null when the band did not change', () => {
    const decision = evaluateRatchet(POLICY, outcomesOver('email.send', 't1', 1), {
      currentBand: 'approve_before_send',
    });
    expect(applyRatchetToPolicy(POLICY, decision)).toBeNull();
  });

  it('moves an action to the promoted band', () => {
    const decision = evaluateRatchet(POLICY, outcomesOver('email.send', 't1', 10), {
      currentBand: 'approve_before_send',
    });
    const updated = applyRatchetToPolicy(POLICY, decision);
    expect(updated).not.toBeNull();
    expect(updated!.bands.approve_before_send?.actions).not.toContain('email.send');
    expect(updated!.bands.notify?.actions).toContain('email.send');
  });

  it('does not mutate the input policy', () => {
    const decision = evaluateRatchet(POLICY, outcomesOver('email.send', 't1', 10), {
      currentBand: 'approve_before_send',
    });
    applyRatchetToPolicy(POLICY, decision);
    expect(POLICY.bands.approve_before_send?.actions).toContain('email.send');
  });
});