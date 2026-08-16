// What the Microsoft grant asks for, and what it reports having received.
//
// Asserted as BEHAVIOUR rather than as string equality against the source, for the reason the Gmail
// suite states: the scope strings are the contract with the vendor, and getting one character wrong
// compiles, reads correctly, and produces a connector that skips every tenant forever with a message
// saying they have not connected.
//
// Two of these tests exist because of traps that are specific to Microsoft and that a reader coming
// from `google.ts` would not expect — the scope prefix Microsoft strips on the way back, and the
// OData escape rule. Both are marked.

import { describe, expect, it } from 'vitest';

import {
  consentUrl,
  grantedFilesAccess,
  isFilesAccess,
  odataQuoted,
  scopesFor,
  type FilesAccess,
} from './microsoft';

const LEVELS: FilesAccess[] = ['readonly', 'readwrite', 'all'];
const each = (fn: (level: FilesAccess) => void) => LEVELS.forEach(fn);

describe('what gets asked for', () => {
  it('always asks for offline_access — without it there is no refresh token at all', () => {
    // The failure this pins is silent and total: the connection works for an hour, then reads as
    // "not connected" with nothing in the logs. It is the single most costly scope to omit.
    each((level) => expect(scopesFor(level).split(' '), level).toContain('offline_access'));
  });

  it('asks for exactly one Files scope per level', () => {
    each((level) => {
      const files = scopesFor(level)
        .split(' ')
        .filter((s) => s.includes('Files.'));
      expect(files, level).toHaveLength(1);
    });
  });

  it('escalates: readonly cannot write, readwrite can, all reaches beyond his own drive', () => {
    expect(scopesFor('readonly')).toContain('Files.Read');
    expect(scopesFor('readonly')).not.toContain('Files.ReadWrite');
    expect(scopesFor('readwrite')).toContain('Files.ReadWrite');
    expect(scopesFor('readwrite')).not.toContain('Files.ReadWrite.All');
    expect(scopesFor('all')).toContain('Files.ReadWrite.All');
  });

  it('never asks for a mail scope at any level', () => {
    // The perimeter is asserted repo-wide in graph-no-send.test.ts. This is the same claim at the
    // one place a mail scope would actually be introduced, so a change here fails twice.
    each((level) => expect(scopesFor(level), level).not.toMatch(/Mail\./));
  });

  it('never asks for Sites.* — SharePoint arrives via Files.ReadWrite.All or not at all', () => {
    // Sites.Read.All is understood to require tenant admin consent, which turns a self-serve connect
    // into an IT ticket. Pinned before it looks like a convenient way to reach one more library.
    each((level) => expect(scopesFor(level), level).not.toMatch(/Sites\./));
  });
});

describe('what actually came back', () => {
  // ⚠️ THE PREFIX TRAP. Microsoft returns granted scopes WITHOUT the resource prefix, even when the
  // request used full URIs. A read-back comparing against the requested strings matches nothing, and
  // every connection reads as declined. These fixtures are deliberately in the returned shape.
  it('recognises the bare scope names Microsoft actually returns', () => {
    expect(grantedFilesAccess('openid profile Files.Read')).toBe('readonly');
    expect(grantedFilesAccess('openid profile Files.ReadWrite')).toBe('readwrite');
    expect(grantedFilesAccess('openid profile Files.ReadWrite.All')).toBe('all');
  });

  it('also recognises fully-qualified scopes, in case that ever changes', () => {
    expect(grantedFilesAccess('https://graph.microsoft.com/Files.ReadWrite')).toBe('readwrite');
  });

  it('reports the WIDEST capability when several are present', () => {
    // A grant carrying both must not report the narrower one: the owner-facing label would then
    // understate what he gave, which is the wrong direction to be wrong in.
    expect(grantedFilesAccess('Files.Read Files.ReadWrite.All')).toBe('all');
    expect(grantedFilesAccess('Files.Read Files.ReadWrite')).toBe('readwrite');
  });

  it('returns null when no file access was granted, so the callback can refuse to save', () => {
    expect(grantedFilesAccess('openid profile email offline_access User.Read')).toBeNull();
    expect(grantedFilesAccess('')).toBeNull();
    expect(grantedFilesAccess(null)).toBeNull();
    expect(grantedFilesAccess(undefined)).toBeNull();
  });

  it('does not mistake a Mail scope for file access', () => {
    expect(grantedFilesAccess('Mail.ReadWrite')).toBeNull();
  });
});

describe('isFilesAccess guards the boundary', () => {
  it('accepts the three levels and nothing else', () => {
    each((level) => expect(isFilesAccess(level), level).toBe(true));
  });

  it('REJECTS Google vocabulary — "picked" has no Microsoft equivalent', () => {
    // The shared connect ticket carries Google's words. Accepting 'picked' here would map a promise
    // of per-file access onto a grant covering the whole OneDrive.
    expect(isFilesAccess('picked')).toBe(false);
    expect(isFilesAccess('full')).toBe(false);
    expect(isFilesAccess(undefined)).toBe(false);
    expect(isFilesAccess('')).toBe(false);
  });
});

describe('odataQuoted', () => {
  // ⚠️ NOT the Drive rule. OData doubles a single quote; Drive escapes it with a backslash. Using the
  // wrong one leaves the query string unterminated.
  it("doubles an apostrophe, so O'Brien Plumbing does not end the string early", () => {
    expect(odataQuoted("O'Brien Plumbing")).toBe("O''Brien Plumbing");
  });

  it('leaves a backslash alone — it is an ordinary character in OData', () => {
    const withBackslash = ['a', 'b'].join(String.fromCharCode(92));
    expect(odataQuoted(withBackslash)).toBe(withBackslash);
  });

  it('handles several apostrophes and leaves ordinary text untouched', () => {
    expect(odataQuoted("O'Brien's")).toBe("O''Brien''s");
    expect(odataQuoted('Quotes 2026')).toBe('Quotes 2026');
    expect(odataQuoted('')).toBe('');
  });
});

describe('the consent URL', () => {
  const build = (level: FilesAccess, loginHint?: string) =>
    new URL(
      consentUrl({
        clientId: 'client-123',
        redirectUri: 'https://connect.kiraexec.com/api/connect/microsoft/callback',
        state: 'state-abc',
        access: level,
        loginHint,
      }),
    );

  it('forces the consent screen, so a returning owner still yields a refresh token', () => {
    expect(build('readwrite').searchParams.get('prompt')).toBe('consent');
  });

  it('carries the state and the scopes for the chosen level', () => {
    const url = build('all');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('scope')).toBe(scopesFor('all'));
  });

  it('sends login_hint only when an address was given', () => {
    expect(build('readwrite', 'ray@garda.com.au').searchParams.get('login_hint')).toBe('ray@garda.com.au');
    // Omitted rather than empty: Microsoft treats a blank hint as a value and can show a chooser
    // pre-filled with nothing, which is worse than no hint at all.
    expect(build('readwrite').searchParams.has('login_hint')).toBe(false);
  });

  it('points at the Microsoft identity platform, not Google', () => {
    expect(build('readwrite').origin).toBe('https://login.microsoftonline.com');
  });
});
