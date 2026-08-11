// Did the owner ask for it to be SENT, or PUT IN HIS DRAFTS?
//
// The distinction decides whether an email leaves the building. "Draft an email to Roger" and "put it
// in my drafts" both contain the word draft and mean opposite things about destination — one is the
// verb for composing, the other names where it must end up.
//
// ⚠️ EVERY CASE HERE IS ASSERTED AS BEHAVIOUR, NEVER AS SOURCE, AND THAT IS DELIBERATE. While this
// function was being written, shell escaping twice turned its \b word boundaries into literal
// BACKSPACE bytes (0x08). The regex still compiled, still read correctly in an editor, and matched
// nothing — the failure already on record as "escapes mangled through tooling". A source assertion
// would have passed over it happily. Only running it catches that.
//
// The utterances marked [real] are verbatim from the 2026-08-11 call that prompted the feature.

import { describe, expect, it } from 'vitest';

import { deliveryFromUtterance } from './drafter';

describe('asking for drafts', () => {
  const wantsDrafts = [
    'just put it in drafts in Gmail', // [real]
    'draft it and then have it sitting in the Gmail drafts for me to review, and I will send it', // [real]
    'Draft follow-up email for lot 442 pegging details to Gary and Chris, save in Gmail drafts', // [real]
    'can you make sure that the email draft is in Gmail for the lot 442', // [real]
    'leave it in my drafts',
    'save it as a draft',
    'put it into the drafts folder',
    'stick it in gmail drafts',
  ];
  for (const u of wantsDrafts) {
    it(`draft: ${u.slice(0, 52)}`, () => expect(deliveryFromUtterance(u)).toBe('draft'));
  }
});

describe('asking for a send', () => {
  const wantsSend = [
    'Draft an email to Roger from Quantum about pegging out lot 442', // the VERB, not the destination
    'draft it',
    'send a follow-up on the lot 442', // [real]
    'email Gary about the soil testing results',
    'write to Chris Newton and confirm the timeline',
    'send that quote to the builder',
  ];
  for (const u of wantsSend) {
    it(`send: ${u.slice(0, 52)}`, () => expect(deliveryFromUtterance(u)).toBe('send'));
  }
});

describe('the word boundaries do real work', () => {
  // These are the cases that pass when \b has been eaten. Without the LEADING boundary, the "in"
  // inside "Martin" matches; without the TRAILING one, "draftsman" does. Both would send an email
  // the owner expected to review first, which is the expensive direction to be wrong in.
  it('does not match the "in" inside a name', () => {
    expect(deliveryFromUtterance('ask Martin drafts are due Friday')).toBe('send');
    expect(deliveryFromUtterance('Robin drafts the scope next week')).toBe('send');
  });

  it('does not match a longer word starting with draft', () => {
    expect(deliveryFromUtterance('send it to the draftsman')).toBe('send');
    expect(deliveryFromUtterance('email the drafting team')).toBe('send');
  });

  it('is not fooled by the word draft appearing anywhere at all', () => {
    expect(deliveryFromUtterance('draft a draft of the draft')).toBe('send');
  });
});

describe('the safe default', () => {
  it('says send when there is nothing to go on', () => {
    // Defaulting to draft would be the safer-looking choice and is the wrong one: this function only
    // ever runs on a request the owner has made, and silently diverting a "send this" into a drafts
    // folder means a client never hears back and nobody finds out.
    expect(deliveryFromUtterance('')).toBe('send');
    expect(deliveryFromUtterance('do the thing')).toBe('send');
  });
});
