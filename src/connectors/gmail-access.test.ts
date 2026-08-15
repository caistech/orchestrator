// How much of his mailbox did the owner actually grant?
//
// The per-tenant partition only means anything if the READ-BACK is honest. A consent screen lets the
// owner untick scopes one at a time, so "we asked for read" and "we have read" are different facts —
// the same reason `grantedDriveAccess` exists and the same reason the callback compares requested
// against granted rather than trusting the request.
//
// Asserted as behaviour throughout. The scope strings are the contract with Google; getting one
// character wrong compiles, reads correctly, and produces a drain that skips every tenant forever
// with a message saying they have not connected.

import { describe, expect, it } from 'vitest';

import { grantedGmailAccess, isGmailAccess, scopesFor, type GmailAccess } from './google';
import { GMAIL_DRAFT_SCOPE } from './gmail-draft';

const COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const DRIVE_FULL = 'https://www.googleapis.com/auth/drive';

describe('what gets asked for', () => {
  it('asks for nothing when the owner chose none', () => {
    const scopes = scopesFor('picked', 'none');
    expect(scopes).not.toMatch(/gmail/);
  });

  it('asks only for compose on draft', () => {
    const scopes = scopesFor('picked', 'draft').split(' ');
    expect(scopes).toContain(COMPOSE);
    expect(scopes).not.toContain(READONLY);
  });

  it('read is ADDITIVE — it does not replace the ability to draft', () => {
    // An owner who chose more must not silently lose what the narrower choice gave him.
    const scopes = scopesFor('picked', 'read').split(' ');
    expect(scopes).toContain(READONLY);
    expect(scopes).toContain(COMPOSE);
  });

  it('never asks for send, or for full mailbox control', () => {
    // Outbound goes through Resend so it carries the tenant's identity, the Spam Act footer and the
    // approval gate. A Gmail send scope would route around all three.
    for (const level of ['none', 'draft', 'read'] as GmailAccess[]) {
      const scopes = scopesFor('full', level);
      expect(scopes).not.toMatch(/gmail\.send/);
      expect(scopes).not.toMatch(/gmail\.modify/);
      expect(scopes).not.toMatch(/mail\.google\.com/);
    }
  });

  it('defaults to none when nobody said', () => {
    // Silence about a mailbox means do not ask for it. An older connect ticket carries no gmail
    // field, and that owner must not meet a consent screen requesting his mail.
    expect(scopesFor('picked')).not.toMatch(/gmail/);
  });

  it('leaves the Drive choice alone', () => {
    expect(scopesFor('full', 'read').split(' ')).toContain(DRIVE_FULL);
  });
});

describe('what actually arrived', () => {
  it('reports read only when BOTH scopes came back', () => {
    expect(grantedGmailAccess(`${READONLY} ${COMPOSE}`)).toBe('read');
  });

  it('reports draft when only compose came back', () => {
    expect(grantedGmailAccess(COMPOSE)).toBe('draft');
  });

  it('reports draft when he unticked readonly on the consent screen', () => {
    // Asked for read, granted compose. This is the case the read-back exists for: acting on the
    // request would have Kira claim she can search his mail and then fail every time she tries.
    expect(grantedGmailAccess(`openid email ${COMPOSE}`)).toBe('draft');
  });

  it('reports none for a connection that predates Gmail entirely', () => {
    expect(grantedGmailAccess(`openid email profile ${DRIVE_FULL}`)).toBe('none');
    expect(grantedGmailAccess(null)).toBe('none');
    expect(grantedGmailAccess(undefined)).toBe('none');
  });

  it('does not report read off readonly alone', () => {
    // Reading without drafting is not a level this system offers. Reporting 'read' here would tell
    // the drafts drain it may proceed, and every drafts.create would then 403 against a token that
    // genuinely cannot write.
    //
    // ⚠️ The first version of this assertion compared the function's output to ITSELF through a
    // ternary — green, permanently, asserting nothing. Left as a note because a tautological test is
    // worse than a missing one: it occupies the space where a real check would have gone.
    expect(grantedGmailAccess(READONLY)).toBe('none');
  });

  it('round-trips every level it asks for', () => {
    // The load-bearing agreement: whatever scopesFor requests, grantedGmailAccess must recognise.
    // A typo in either string breaks this and nothing else would.
    for (const level of ['draft', 'read'] as GmailAccess[]) {
      expect(grantedGmailAccess(scopesFor('picked', level))).toBe(level);
    }
    expect(grantedGmailAccess(scopesFor('picked', 'none'))).toBe('none');
  });
});

describe('the guard and the drain agree on the scope string', () => {
  it('gmail-draft depends on the same compose scope that is requested', () => {
    // Two modules naming the same Google scope in two places is how a drain starts skipping every
    // tenant while the connection is perfectly healthy.
    expect(GMAIL_DRAFT_SCOPE).toBe(COMPOSE);
    expect(scopesFor('picked', 'draft')).toContain(GMAIL_DRAFT_SCOPE);
  });
});

describe('the type guard', () => {
  it('accepts the three levels and nothing else', () => {
    expect(isGmailAccess('none')).toBe(true);
    expect(isGmailAccess('draft')).toBe(true);
    expect(isGmailAccess('read')).toBe(true);
    expect(isGmailAccess('modify')).toBe(false);
    expect(isGmailAccess('')).toBe(false);
    expect(isGmailAccess(undefined)).toBe(false);
  });
});
