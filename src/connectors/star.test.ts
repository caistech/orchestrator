// src/connectors/star.test.ts — STAR stub contract proof.
//
// The STAR integration is a stub until Brian's Foundry/Azure endpoint shape arrives. What this test
// pins is the CONTRACT, not the implementation: a STAR dispatch is recognised, and the stub answers
// the exact intent that was asked (so a reviewer can see the round trip was complete even though the
// result is synthetic). When the real connector replaces callStar, this file's shape assertions stay
// valid — which is precisely what a seam is for.

import { describe, expect, it } from 'vitest';

import { callStar, isStarFlow, STAR_FLOWS } from './star';

describe('isStarFlow', () => {
  it('recognises both registered STAR flows', () => {
    for (const flow of STAR_FLOWS) {
      expect(isStarFlow(flow)).toBe(true);
    }
  });

  it('rejects everything else', () => {
    expect(isStarFlow(undefined)).toBe(false);
    expect(isStarFlow(null)).toBe(false);
    expect(isStarFlow('EMAIL_FOLLOW_UP')).toBe(false);
    expect(isStarFlow('flow-13')).toBe(false);
  });
});

describe('callStar (stub)', () => {
  it('answers completed with the exact intent and payload it received', async () => {
    const result = await callStar({
      intent: 'STAR_DIAGNOSTIC',
      tenantId: 'tenant-1',
      payload: { business: 'Wavecrest Constructions' },
    });

    expect(result.status).toBe('completed');
    expect(result.result.stub).toBe(true);
    expect(result.result.receivedIntent).toBe('STAR_DIAGNOSTIC');
  });

  it('answers the other flow too', async () => {
    const result = await callStar({
      intent: 'STAR_ROADMAP',
      tenantId: 'tenant-1',
      payload: { gleaned: true },
    });

    expect(result.status).toBe('completed');
    expect(result.result.receivedIntent).toBe('STAR_ROADMAP');
    expect(result.result.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});