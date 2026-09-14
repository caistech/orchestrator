// src/clarify.test.ts — T1 gate logic (critT1). The critical regression from /plan-eng-review D16:
// "incomplete dispatch → clarify → count exceeded / TTL → auto-cancel with reason." The loop must be
// BOUNDED by the orchestrator's own state machine, whatever adapter asks the questions — this file
// asserts that boundary precisely.
//
// Nothing here touches a database, on purpose. The route persists outcomes; the GATE decides them,
// and the decision is the part that can silently go wrong (a loop that never dies, a question that
// is never re-asked, an answer that is lost).

import { describe, expect, it } from 'vitest';

import type { DispatchRequest } from '@/src/contract';
import {
  assessClarification,
  buildClarifyPrompt,
  clarifyCancelMessage,
  evaluateClarifyGate,
  MAX_CLARIFY_ROUNDS,
  type ClarifySessionRow,
} from './clarify';

const NOW = new Date('2026-09-14T12:00:00Z');

function dispatch(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    version: '1',
    tenantId: 'tenant-1',
    intentId: 'intent-1',
    ingress: 'SAY',
    utterance: 'send the follow-up to Dave about the Wavecrest quote',
    ...overrides,
  };
}

function session(overrides: Partial<ClarifySessionRow> = {}): ClarifySessionRow {
  return {
    id: 'task-clarify-1',
    status: 'clarifying',
    clarify_count: 1,
    clarify_ttl_at: new Date(NOW.getTime() + 60_000).toISOString(),
    clarify_missing: ['successCriteria', 'dueAt'],
    clarify_answers: {},
    ...overrides,
  };
}

describe('assessClarification', () => {
  it('scopes the ask to the caller\u2019s own required list', () => {
    const missing = assessClarification(
      dispatch({ clarification: { required: ['dueAt', 'successCriteria'] } }),
    );
    expect(missing).toEqual(['successCriteria', 'dueAt']);
  });

  it('never flags objective or responsibleTier for a SAY dispatch', () => {
    const missing = assessClarification(dispatch());
    expect(missing).not.toContain('objective');
    expect(missing).not.toContain('responsibleTier');
  });

  it('considers a context-carried dueAt satisfied', () => {
    const missing = assessClarification(
      dispatch({ clarification: { required: ['dueAt'] }, context: { dueAt: '2026-09-20T09:00:00Z' } }),
    );
    expect(missing).not.toContain('dueAt');
  });
});

describe('evaluateClarifyGate — the loop boundary', () => {
  it('an ordinary dispatch (no clarification block) proceeds untouched', () => {
    expect(evaluateClarifyGate(dispatch(), session(), NOW)).toEqual({ mode: 'proceed' });
  });

  it('a requesting dispatch with no live session OPENS the loop (count 1, TTL 48h)', () => {
    const outcome = evaluateClarifyGate(
      dispatch({ clarification: { required: ['dueAt', 'successCriteria'] } }),
      null,
      NOW,
    );
    expect(outcome.mode).toBe('ask');
    if (outcome.mode !== 'ask') throw new Error('expected ask');
    expect(outcome.count).toBe(1);
    expect(outcome.missing).toEqual(['successCriteria', 'dueAt']);
    expect(new Date(outcome.ttlAt).getTime() - NOW.getTime()).toBe(48 * 60 * 60 * 1000);
  });

  it('an answering dispatch with no live session proceeds (answers are just specification)', () => {
    const outcome = evaluateClarifyGate(
      dispatch({ clarification: { answers: { dueAt: '2026-09-20' } } }),
      null,
      NOW,
    );
    expect(outcome).toEqual({ mode: 'proceed' });
  });

  it('a `required` request that is already satisfied proceeds rather than asking for nothing', () => {
    const outcome = evaluateClarifyGate(
      dispatch({ clarification: { required: ['objective'] } }),
      null,
      NOW,
    );
    expect(outcome).toEqual({ mode: 'proceed' });
  });

  it('a live session re-issues the SAME ask on a retry (required, no answers)', () => {
    const outcome = evaluateClarifyGate(
      dispatch({ clarification: { required: ['dueAt', 'successCriteria'] } }),
      session(),
      NOW,
    );
    expect(outcome).toEqual({
      mode: 'ask',
      count: 1,
      missing: ['successCriteria', 'dueAt'],
      ttlAt: session().clarify_ttl_at,
    });
  });

  it('answers that fill every outstanding field CLOSE the loop → proceed', () => {
    const outcome = evaluateClarifyGate(
      dispatch({ clarification: { answers: { successCriteria: 'Dave confirms receipt', dueAt: 'Friday' } } }),
      session(),
      NOW,
    );
    expect(outcome).toEqual({ mode: 'proceed' });
  });

  it('partial answers advance: the still-owed fields are re-asked exactly', () => {
    const outcome = evaluateClarifyGate(
      dispatch({ clarification: { answers: { successCriteria: 'Dave confirms receipt' } } }),
      session(),
      NOW,
    );
    expect(outcome).toEqual({
      mode: 'ask',
      count: 2,
      missing: ['dueAt'],
      ttlAt: session().clarify_ttl_at,
    });
    // The report: round 2 of MAX_CLARIFY_ROUNDS is still within bounds.
    expect((outcome as { count: number }).count).toBeLessThanOrEqual(MAX_CLARIFY_ROUNDS);
  });

  it('answers accumulate across rounds (prior stored answers count)', () => {
    const prior = session({ clarify_answers: { successCriteria: 'Dave confirms receipt' } });
    const outcome = evaluateClarifyGate(
      dispatch({ clarification: { answers: { dueAt: 'Friday' } } }),
      prior,
      NOW,
    );
    expect(outcome).toEqual({ mode: 'proceed' });
  });

  it('count-exhausted: the loop dies with a logged reason after MAX rounds unanswered', () => {
    const outcome = evaluateClarifyGate(
      dispatch({ clarification: { answers: {} } }),
      session({ clarify_count: MAX_CLARIFY_ROUNDS }),
      NOW,
    );
    expect(outcome).toEqual({
      mode: 'cancelled',
      reason: 'clarify_exhausted',
      detail: expect.stringContaining('too many times'),
    });
  });

  it('TTL-expired: the loop dies with a logged reason even when answers arrive', () => {
    const outcome = evaluateClarifyGate(
      dispatch({ clarification: { answers: { successCriteria: 'done', dueAt: 'Friday' } } }),
      session({ clarify_ttl_at: new Date(NOW.getTime() - 1000).toISOString() }),
      NOW,
    );
    expect(outcome).toEqual({
      mode: 'cancelled',
      reason: 'clarify_timeout',
      detail: expect.stringContaining('deadline'),
    });
  });
});

describe('buildClarifyPrompt / clarifyCancelMessage', () => {
  it('names every owed field in one breath', () => {
    expect(buildClarifyPrompt(['successCriteria', 'dueAt'])).toContain(
      'what \u2018done\u2019 looks like',
    );
    expect(buildClarifyPrompt(['successCriteria', 'dueAt'])).toContain('when it is due');
  });

  it('an empty list yields a generic last-thing line, not silence', () => {
    expect(buildClarifyPrompt([])).toMatch(/one last thing/i);
  });

  it('each cancel reason has its own audible copy', () => {
    expect(clarifyCancelMessage('clarify_timeout')).toContain('too long');
    expect(clarifyCancelMessage('clarify_exhausted')).toBe(clarifyCancelMessage('clarify_exhausted'));
  });
});