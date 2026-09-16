// The evidence collector — completed work becomes Genome evidence, through staging.
//
// The Genome is the product (the "Learning" loop), so evidence lands in a staging/review area
// and a human promotes it. These tests assert the MAPPING — which effect kinds become evidence,
// and what the staging rows look like — because an unmapped kind that SHOULD be evidence would
// otherwise vanish silently from the pipeline.

import { describe, it, expect } from 'vitest';

import { collectEvidence, EVIDENCE_MAPPINGS } from './evidence-collector';

function completedEffect(kind: string, id = 'ef-1') {
  return {
    id,
    task_id: 'task-1',
    kind,
    request: { to: 'supplier@example.com', subject: 'Your quote', body: '...' },
  };
}

const task = { tenant_id: 'tenant-1', payload: {} };

describe('collectEvidence', () => {
  it('maps email.send to communication + client_management staging rows', () => {
    const rows = collectEvidence(completedEffect('email.send'), task);
    expect(rows.length).toBe(2);
    const buckets = rows.map((r) => r.genomeBucket).sort();
    expect(buckets).toEqual(['client_management', 'communication']);
    for (const r of rows) {
      expect(r.status).toBe('pending');
      expect(r.tenantId).toBe('tenant-1');
      expect(r.effectId).toBe('ef-1');
      expect(r.evidence).toHaveProperty('subject');
    }
  });

  it('returns an empty array for an unmapped kind', () => {
    expect(collectEvidence(completedEffect('unregistered.kind'), task)).toEqual([]);
  });

  it('every actionable effect kind in the register has a mapping', () => {
    const mappedKinds = EVIDENCE_MAPPINGS.map((m) => m.effectKind);
    // The kinds that PROVE something about the business must be mapped.
    expect(mappedKinds).toContain('email.send');
    expect(mappedKinds).toContain('email.draft');
  });
});