// NOTHING IN THIS REPOSITORY MAY SEND MAIL THROUGH MICROSOFT GRAPH. Asserted across every file.
//
// The Microsoft half of the perimeter `gmail-no-send.test.ts` holds for Google. Written BEFORE any
// Graph mail path exists, which is the entire point: a guard that names Gmail specifically would pass
// a Graph send on day one, and it is far easier to argue for this now than after someone has a
// working draft flow and a deadline. `docs/BRIEF_ORCHESTRATOR_DRIVE_FILE_SCOPES.md` §7 asked for
// exactly this.
//
// THE UNDERLYING CLAIM IS NOT ABOUT A VENDOR. It is that nothing sends mail outside the compliance
// path — the tenant's sender identity, the Spam Act footer, the suppression store, the AU-only
// jurisdiction guard and the approval gate. Resend is that path. `Mail.Send` routes around all five,
// exactly as `gmail.send` would, and no amount of care at the call site puts them back.
//
// WHY MICROSOFT IS WORSE THAN GOOGLE HERE, and why the scope assertions below matter more than the
// endpoint one: Gmail has `gmail.compose`, which can draft without reading. Graph has no draft-only
// permission at all — `Mail.ReadWrite` grants the whole mailbox. So on this vendor there is no
// "just drafts" grant to reach for, and the first person who wants drafting will be tempted to take
// `Mail.ReadWrite` and reason that the code only ever drafts. This suite makes that a visible
// decision in a diff instead of a quiet one.
//
// WHAT THIS CANNOT DO, stated rather than implied. It proves no SOURCE FILE names a send endpoint or
// requests a mail scope. It cannot prove a token is never misused — a URL assembled at runtime from
// data, or an unpinned dependency issuing its own request, would pass. It is a floor, not a proof.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const SEARCHED = ['src', 'app', 'lib', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build']);

/** This file names the forbidden paths in order to forbid them, so it must exempt itself. */
const SELF = path.resolve(__dirname, 'graph-no-send.test.ts');
/** The connector's own suite asserts the absence of mail scopes at the point they would be added. */
const SIBLING = path.resolve(__dirname, 'microsoft.test.ts');
/** The consent copy suite quotes the same strings to prove the copy never offers mail. */
const COPY = path.resolve(__dirname, 'microsoft-consent-copy.test.ts');
const EXEMPT = new Set([SELF, SIBLING, COPY]);

function sourceFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return []; // A directory this repo does not have is not a finding.
  }
  return entries.flatMap((entry) => {
    if (SKIP_DIRS.has(entry)) return [];
    const full = path.join(abs, entry);
    if (statSync(full).isDirectory()) return sourceFiles(path.join(dir, entry));
    return /\.(ts|tsx|js|mjs)$/.test(entry) ? [full] : [];
  });
}

const FILES = SEARCHED.flatMap(sourceFiles).filter((f) => !EXEMPT.has(f));

/** Comments are stripped: an honest note explaining why we do not send must not fail as a send. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const read = (f: string) => strip(readFileSync(f, 'utf8'));

const offenders = (pattern: RegExp) =>
  FILES.filter((f) => pattern.test(read(f))).map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));

describe('no file anywhere composes a Graph mail send', () => {
  it('found files to search — an empty sweep must never read as a pass', () => {
    // The failure mode this guards: a refactor moves `src/`, the walker silently returns nothing,
    // and every assertion below passes vacuously forever.
    expect(FILES.length).toBeGreaterThan(20);
    expect(FILES.some((f) => f.endsWith('microsoft.ts'))).toBe(true);
  });

  it('names no /sendMail endpoint', () => {
    expect(offenders(/sendMail/i)).toEqual([]);
  });

  it('names no messages/{id}/send endpoint — the other way to post mail with this token', () => {
    // Graph's draft-then-send path. Distinct from sendMail and just as final.
    expect(offenders(/messages\/[^'"`\s]*\/send/i)).toEqual([]);
  });

  it('never requests Mail.Send', () => {
    expect(offenders(/Mail\.Send/)).toEqual([]);
  });

  it('never requests Mail.ReadWrite — which also permits sending, and reads the whole mailbox', () => {
    // There is no draft-only Graph scope. If drafting is ever wanted this test is the conversation:
    // deleting it means accepting that the grant reads his entire mailbox, and the consent page must
    // then say so in those words.
    expect(offenders(/Mail\.ReadWrite/)).toEqual([]);
  });

  it('never requests Mail.Read either — no mailbox scope of any kind is asked for today', () => {
    expect(offenders(/Mail\.Read\b/)).toEqual([]);
  });

  it('never requests the SMTP or IMAP delegated scopes', () => {
    // The back door: Graph is not the only way Microsoft will hand over a mailbox. An owner's
    // credentials plus SMTP.Send bypasses every assertion above.
    expect(offenders(/SMTP\.Send|IMAP\.AccessAsUser/i)).toEqual([]);
  });
});

describe('the Graph endpoint surface stays where it can be reviewed', () => {
  it('only microsoft.ts talks to the Graph API at all', () => {
    // If a second file needs Graph, that is a design decision to be argued for in a diff — not
    // something that arrives because a route handler already had a token in scope. Mirrors the same
    // assertion the Gmail suite makes about gmail-draft.ts.
    expect(offenders(/graph\.microsoft\.com/)).toEqual(['src/connectors/microsoft.ts']);
  });

  it('never reaches the /me/messages or /me/mailFolders collections', () => {
    // Reading mail needs no send endpoint at all, and a read is what the scopes above are meant to
    // prevent. Belt and braces: the scope assertions are the boundary, this catches the attempt.
    expect(offenders(/\/me\/(messages|mailFolders)/i)).toEqual([]);
  });
});
