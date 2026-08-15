// NOTHING IN THIS REPOSITORY MAY SEND GMAIL. Asserted across every file, not one.
//
// WHY THIS EXISTS SEPARATELY FROM gmail-draft.test.ts.
//
// That suite is right about the mechanism and too narrow about the perimeter. It greps
// `gmail-draft.ts` for a send path, because that module was written as the one place holding a
// Gmail-capable credential. It is not the one place. `accessTokenFor` is exported, and five call
// sites hold its result today:
//
//   app/api/v1/tenants/[tenantId]/lookup/route.ts   (contact lookup)
//   app/api/v1/tenants/[tenantId]/record/route.ts   (write-back)
//   src/connectors/google-contacts.ts               (people search)
//   src/knowledge/quote-format.ts                   (reads Drive to learn his format)
//   src/connectors/gmail-draft.ts                   (the guarded one)
//
// AND THE TOKEN IS UNITARY. Google issues ONE bearer token carrying every granted scope, so on a
// tenant who chose 'draft' or 'read', the token `quote-format.ts` uses to read a Drive file is a
// token that can send mail. There is no module boundary that changes that, because the credential is
// not partitioned — only the code that uses it is. Partitioning by module was the plan; what the
// plan actually buys is that no code composes a send, and that is a property of the WHOLE tree.
//
// So the assertion has to be repo-wide, and it has to hold for the file somebody adds next — which
// is the real case, since a guard that covers only the files that existed when it was written is a
// guard that decays silently. The repo has been bitten by exactly this shape before: a check that
// existed and ran nowhere.
//
// WHAT THIS CANNOT DO, stated rather than implied. It proves no SOURCE FILE names a send endpoint.
// It cannot prove the token is never misused — a URL assembled at runtime from data, or an
// unpinned dependency issuing its own request, would pass. It is a floor, not a proof. The ceiling
// is that `gmail.send` is never requested and `messages/send` never appears; the floor is that
// nobody can add it without turning this red.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const SEARCHED = ['src', 'app', 'lib', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build']);

/** This file names the forbidden paths in order to forbid them, so it must exempt itself. */
const SELF = path.resolve(__dirname, 'gmail-no-send.test.ts');
/** The sibling suite quotes the same strings for the same reason. */
const SIBLING = path.resolve(__dirname, 'gmail-draft.test.ts');
const EXEMPT = new Set([SELF, SIBLING]);

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

describe('no file anywhere composes a Gmail send', () => {
  it('found files to search — an empty sweep must never read as a pass', () => {
    // The failure mode this guards: a refactor moves `src/`, the walker silently returns nothing,
    // and every assertion below passes vacuously forever.
    expect(FILES.length).toBeGreaterThan(20);
    expect(FILES.some((f) => f.endsWith('gmail-draft.ts'))).toBe(true);
  });

  it('names no messages/send endpoint', () => {
    const offenders = FILES.filter((f) => /messages\/send/.test(read(f)));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('names no drafts/{id}/send endpoint — the other way to post mail with this token', () => {
    const offenders = FILES.filter((f) => /drafts\/[^'"`\s]*\/send/.test(read(f)));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('never requests the gmail.send scope', () => {
    const offenders = FILES.filter((f) => /auth\/gmail\.send/.test(read(f)));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('never requests gmail.modify — which also permits sending', () => {
    // Not currently anywhere, and worth pinning before it looks like a convenient way to get one
    // more Gmail capability. `modify` carries send, so adopting it would reopen this silently.
    const offenders = FILES.filter((f) => /auth\/gmail\.modify/.test(read(f)));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('never requests mail.google.com — the full-mailbox scope', () => {
    const offenders = FILES.filter((f) => /mail\.google\.com/.test(read(f)));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});

describe('the Gmail endpoint surface is exactly one URL, in exactly one file', () => {
  it('only gmail-draft.ts talks to the Gmail API at all', () => {
    const talkers = FILES.filter((f) => /gmail\.googleapis\.com/.test(read(f))).map((f) =>
      path.relative(ROOT, f).replace(/\\/g, '/'),
    );
    // If a second file needs Gmail, that is a design decision that should be argued for in a diff —
    // not something that arrives because a route handler already had a token in scope.
    expect(talkers).toEqual(['src/connectors/gmail-draft.ts']);
  });
});
