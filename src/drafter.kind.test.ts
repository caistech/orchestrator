// The dispatch route's kind vocabulary is the classifier's contract with the rest of the system,
// and it has been wrong before: `compliance` was a registered kind with an agent (verified green by
// check:agents) that the classifier could never emit — the async worker had an input contract nobody
// could write. That is a wiring bug with a green suite, the expensive kind. coerceKind is the small
// pure function that decides, so it gets a test that names the contract out loud.

import { describe, expect, it } from 'vitest';

import { coerceKind } from './drafter';

describe('coerceKind', () => {
  it('keeps owned kinds (the sync draft-and-hold path)', () => {
    expect(coerceKind('quote')).toBe('quote');
    expect(coerceKind('email')).toBe('email');
    expect(coerceKind('reminder')).toBe('reminder');
  });

  it('keeps async kinds registered in the agent registry (the worker path)', () => {
    expect(coerceKind('compliance')).toBe('compliance');
  });

  it('maps unrecognised and missing kinds to the unsupported backlog', () => {
    expect(coerceKind('booking')).toBe('unsupported');
    expect(coerceKind(null)).toBe('unsupported');
    expect(coerceKind(undefined)).toBe('unsupported');
    expect(coerceKind('')).toBe('unsupported');
  });
});