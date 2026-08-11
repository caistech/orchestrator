// The drafting module must not be able to become a sending module.
//
// `gmail.compose` is the narrowest Google scope that can create a draft and it ALSO permits sending;
// there is no draft-only scope. So the credential this module holds can send, and the only control
// is this file. That makes "does this file contain a send path?" a real assertion rather than a
// stylistic one — the same reasoning that made `xero-read.ts` hardcode its verb.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildRawMessage, hasGmailScope, GMAIL_DRAFT_SCOPE } from './gmail-draft';

const source = readFileSync(path.resolve(__dirname, 'gmail-draft.ts'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('it cannot send', () => {
  it('names no Gmail send endpoint anywhere in the module', () => {
    // messages/send and drafts/{id}/send are the two ways to post mail with this token.
    expect(code).not.toMatch(/messages\/send/);
    expect(code).not.toMatch(/drafts\/[^'"`\s]*\/send/);
    expect(code).not.toMatch(/\.send\b/);
  });

  it('writes the endpoint as a literal rather than building one', () => {
    // A module that takes an endpoint, or concatenates a path, is one careless call site away from
    // sending. The URL is a const and there is exactly one of it.
    expect(code).toMatch(/const DRAFTS_CREATE_URL = 'https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/drafts'/);
    expect(code.match(/gmail\.googleapis\.com/g)?.length).toBe(1);
  });

  it('uses exactly one fetch, with the verb written out', () => {
    expect(code.match(/await fetch\(/g)?.length).toBe(1);
    expect(code).toMatch(/method: 'POST'/);
  });
});

describe('it never assumes the scope was granted', () => {
  it('reads back what actually arrived', () => {
    expect(hasGmailScope(`openid email ${GMAIL_DRAFT_SCOPE}`)).toBe(true);
    expect(hasGmailScope('openid email https://www.googleapis.com/auth/drive.readonly')).toBe(false);
    expect(hasGmailScope(null)).toBe(false);
    expect(hasGmailScope(undefined)).toBe(false);
  });

  it('does not match on a prefix', () => {
    // gmail.compose.readonly does not exist today, but a substring check would accept a future
    // narrower scope as though it were this one, and the failure would be a silent no-write.
    expect(hasGmailScope('https://www.googleapis.com/auth/gmail.composeXX')).toBe(false);
  });
});

describe('the message it builds', () => {
  it('puts recipients, subject and body where Gmail expects them', () => {
    const raw = Buffer.from(
      buildRawMessage({ to: 'roger@quantumsurveys.com.au', subject: 'Lot 442 pegging', body: 'Roger,\n\nChecking in.' }),
      'base64url',
    ).toString('utf8');
    expect(raw).toContain('To: roger@quantumsurveys.com.au');
    expect(raw).toContain('Subject: Lot 442 pegging');
    expect(raw).toContain('Checking in.');
    // Headers and body separated by a blank line, or the whole thing is one header block.
    expect(raw).toMatch(/\r\n\r\n/);
  });

  it('joins multiple recipients', () => {
    const raw = Buffer.from(buildRawMessage({ to: ['a@b.com', 'c@d.com'], subject: 's' }), 'base64url').toString('utf8');
    expect(raw).toContain('To: a@b.com, c@d.com');
  });

  it('encodes a non-ASCII subject rather than emitting an invalid header', () => {
    // A raw non-ASCII byte in a header is not merely untidy — it makes the header invalid, and Gmail
    // rejects the draft without saying which field was wrong.
    const raw = Buffer.from(buildRawMessage({ to: 'a@b.com', subject: 'Café — Lot 442' }), 'base64url').toString('utf8');
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(raw).not.toContain('Subject: Café');
  });

  it('survives a missing subject and body without producing a broken message', () => {
    const raw = Buffer.from(buildRawMessage({ to: 'a@b.com' }), 'base64url').toString('utf8');
    expect(raw).toContain('To: a@b.com');
    expect(raw).toContain('Subject: ');
  });
});
