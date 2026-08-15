// The copy and the scopes must agree, for every combination the owner can choose.
//
// This is the guard the invitation email never had. The old templates stated a fixed permission list
// that was true of one configuration — and the two claims most likely to matter to a cautious owner,
// "only files you share" and "cannot read your personal emails", were each false at a level the
// system can actually be configured to. Nothing would have caught it: markdown does not typecheck,
// and the person sending the email is not the person who changed the scope map.
//
// So every assertion here derives its expectation from `scopesFor()` rather than restating it. Add a
// scope without updating the copy and this goes red; change a level's meaning and it goes red.

import { describe, expect, it } from 'vitest';

import { scopesFor, type DriveAccess, type GmailAccess } from './google';
import { connectionBlurb, permissionSummary } from './google-consent-copy';

const DRIVE: DriveAccess[] = ['picked', 'readonly', 'full'];
const GMAIL: GmailAccess[] = ['none', 'draft', 'read'];

const every = (fn: (d: DriveAccess, g: GmailAccess) => void) =>
  DRIVE.forEach((d) => GMAIL.forEach((g) => fn(d, g)));

const text = (d: DriveAccess, g: GmailAccess) => {
  const s = permissionSummary(d, g);
  return [...s.can, ...s.cannot].join(' | ').toLowerCase();
};

describe('the mailbox claims track the mailbox scopes', () => {
  it('claims no email access exactly when no Gmail scope is requested', () => {
    every((d, g) => {
      const asked = scopesFor(d, g).includes('gmail');
      const claimsNone = text(d, g).includes('asks for no access to your mailbox');
      expect(claimsNone, `${d}/${g}`).toBe(!asked);
    });
  });

  it('promises the mailbox is unreadable ONLY where readonly was not requested', () => {
    every((d, g) => {
      const canRead = scopesFor(d, g).includes('gmail.readonly');
      const promisesUnreadable = text(d, g).includes('read your email — it can only put a draft');
      // The dangerous direction: promising unreadability on a grant that can read.
      if (canRead) expect(promisesUnreadable, `${d}/${g}`).toBe(false);
    });
  });

  it('offers to read the mailbox exactly when readonly was requested', () => {
    every((d, g) => {
      const canRead = scopesFor(d, g).includes('gmail.readonly');
      expect(text(d, g).includes('read your gmail'), `${d}/${g}`).toBe(canRead);
    });
  });

  it('offers to draft exactly when compose was requested', () => {
    every((d, g) => {
      const canDraft = scopesFor(d, g).includes('gmail.compose');
      expect(text(d, g).includes('write a message into your gmail drafts'), `${d}/${g}`).toBe(canDraft);
    });
  });
});

describe('the Drive claims track the Drive scope', () => {
  it('promises "only what you share" ONLY on drive.file', () => {
    every((d, g) => {
      const narrow = scopesFor(d, g).includes('auth/drive.file');
      const promises = text(d, g).includes('never sees the files you have not shared');
      expect(promises, `${d}/${g}`).toBe(narrow);
    });
  });

  it('promises nothing will be changed ONLY where no write scope was requested', () => {
    every((d, g) => {
      // Full Drive is the one level that can write. `.file` can write to its own files, but the
      // owner-facing promise here is about HIS existing files, which it cannot touch unshared.
      const canWriteAnything = scopesFor(d, g).split(' ').includes('https://www.googleapis.com/auth/drive');
      const promises = text(d, g).includes('change, move or delete any of your files');
      expect(promises, `${d}/${g}`).toBe(!canWriteAnything);
    });
  });
});

describe('the promise that holds at every level', () => {
  it('never requests gmail.send, and never offers sending as a capability', () => {
    every((d, g) => {
      expect(scopesFor(d, g), `${d}/${g}`).not.toContain('gmail.send');
      // The `can` list must never offer it. This is the claim the old templates got wrong — they
      // advertised "Send emails on your behalf" as a Google permission at every level.
      expect(permissionSummary(d, g).can.join(' ').toLowerCase(), `${d}/${g}`).not.toMatch(
        /send (email|anything).* from your gmail/,
      );
    });
  });

  it('spells out that it cannot send, wherever a mailbox scope IS requested', () => {
    every((d, g) => {
      // `gmail.compose` is what Google shows him, and it reads as permission to send. Where it is
      // requested, the copy owes him the correction; where no mailbox scope is asked for, the
      // blanket "cannot touch your email" already covers it and a second line reads as hedging.
      const asked = scopesFor(d, g).includes('gmail');
      const says = text(d, g).includes('send anything from your gmail');
      expect(says, `${d}/${g}`).toBe(asked);
      if (!asked) expect(text(d, g)).toContain('touch your email');
    });
  });

  it('always names contacts as read-only lookup, which both scopes are', () => {
    every((d, g) => {
      const s = scopesFor(d, g);
      expect(s).toContain('contacts.readonly');
      expect(s).toContain('contacts.other.readonly');
      expect(text(d, g)).toContain('look up your saved contacts');
    });
  });
});

describe('the blurb above the button', () => {
  it('names Gmail only when Gmail was actually asked for', () => {
    every((d, g) => {
      const asked = scopesFor(d, g).includes('gmail');
      expect(connectionBlurb(d, g).toLowerCase().includes('gmail'), `${d}/${g}`).toBe(asked);
    });
  });

  it('says "the files you choose" on picked, and "your Google Drive" otherwise', () => {
    expect(connectionBlurb('picked', 'none')).toContain('the Google Drive files you choose');
    expect(connectionBlurb('readonly', 'none')).toContain('your Google Drive');
    expect(connectionBlurb('full', 'none')).toContain('your Google Drive');
  });

  it('reads as a sentence, not a list with a trailing comma', () => {
    expect(connectionBlurb('picked', 'draft')).toBe(
      'the Google Drive files you choose, your Gmail and your contacts',
    );
    expect(connectionBlurb('readonly', 'none')).toBe('your Google Drive and your contacts');
  });
});
