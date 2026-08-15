// The place that WRITES the delivery preference and the place that READS it must agree.
//
// THE DEFECT THIS PINS. `dispatch` spreads the whole `classified` object into the task payload, so
// `delivery` arrived at `payload.classified.delivery`. `approve` reads `payload.delivery`. It found
// nothing, fell through to its `'send'` default, and every request to put a message in the owner's
// Gmail drafts would have been SENT instead — with the register green, the executor bound, the drain
// working, and the whole email.draft path looking wired while never once running.
//
// Nothing would have caught that. tsc is happy (both are `unknown`-ish reads off a jsonb column),
// the tool register is happy (the kind exists and is executable), and the only symptom is an email
// leaving the building when the owner expected to review it first.
//
// So this asserts the AGREEMENT rather than either side alone. Source assertions, in the style of
// the sibling guards, because both files are route handlers that reach Supabase and a model API —
// running them here would test the harness, and the thing that broke is one line of shape.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repo = (p: string) => readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const dispatch = strip(repo('app/api/v1/dispatch/route.ts'));
const approve = strip(repo('app/api/v1/tasks/[id]/approve/route.ts'));

describe('the write side', () => {
  it('puts delivery at the TOP LEVEL of the payload', () => {
    // Not nested under `classified`. That is the entire bug.
    expect(dispatch).toMatch(/payload: \{[\s\S]*?\bdelivery:/);
  });

  it('prefers the caller, falls back to the classifier, floors at send', () => {
    // The order is the contract. Reversing the first two would let a regex over the owner's words
    // outrank Kira passing his explicit instruction.
    const block = dispatch.slice(dispatch.indexOf('delivery:'), dispatch.indexOf('classified: classified'));
    expect(block).toMatch(/body\.payload[\s\S]*\?\.delivery/);
    expect(block).toMatch(/classified\?\.delivery/);
    expect(block).toMatch(/'send'/);
    expect(block.indexOf('body.payload')).toBeLessThan(block.indexOf('classified?.delivery'));
    expect(block.indexOf('classified?.delivery')).toBeLessThan(block.indexOf("'send'"));
  });
});

describe('the read side', () => {
  it('reads payload.delivery, not payload.classified.delivery', () => {
    expect(approve).toMatch(/payload as \{ delivery\?: string \}/);
    // Reaching through `classified` would couple the approver to the classifier's shape, and a
    // change to one would silently break the other.
    expect(approve).not.toMatch(/classified[\s\S]{0,20}delivery/);
  });

  it('chooses the effect kind from it, and defaults to send', () => {
    expect(approve).toMatch(/=== 'draft' \? 'email\.draft' : 'email\.send'/);
    expect(approve).toMatch(/connector: .*'google' : 'resend'/);
  });

  it('never emits the plural kind', () => {
    // `email.drafts` is registered nowhere and bound to nothing. It would insert cleanly, flip the
    // task to queued, answer "Approved — queued to send", and sit pending forever. One character.
    expect(approve).not.toMatch(/email\.drafts/);
    expect(dispatch).not.toMatch(/email\.drafts/);
  });
});
