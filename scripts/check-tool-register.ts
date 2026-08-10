// Assertions for the tool register.  Run: npm run check:tools
//
// The register is split in two on purpose — config/tools.json holds the facts, src/tools/executors.ts
// holds the binding, because a string module path cannot be statically bundled and would fail in
// production rather than in CI. Splitting it buys that safety and costs one risk: the two halves
// drifting. This is the check that makes drift impossible to ship.
//
// It also closes the loop the register was built for. The drain reports an unregistered kind at
// RUNTIME, which is loud but late — the effect has already been emitted and is already stuck. This
// asserts at BUILD time that every effect kind the code can emit is registered, so the stuck row
// never happens.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { allTools, executableKinds, isExecutable } from '../src/tools/register';
import { boundKinds } from '../src/tools/executors';

let failures = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`ok    ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

// ── the register parses at all ────────────────────────────────────────────────
// Importing it already threw if not — validate() refuses rather than filtering. Reaching this line
// is the assertion.
check('config/tools.json parses and validates', true);
console.log(`      ${allTools().length} tool(s): ${allTools().map((t) => t.kind).join(', ')}`);

// ── the two halves agree ──────────────────────────────────────────────────────
const registered = executableKinds();
const bound = boundKinds();

for (const kind of registered) {
  check(
    `"${kind}" is class:effect and has an executor bound`,
    bound.includes(kind),
    `Registered in config/tools.json but missing from EXECUTORS in src/tools/executors.ts. ` +
      `The drain would log an error and execute nothing.`,
  );
}

for (const kind of bound) {
  check(
    `executor "${kind}" is registered`,
    registered.includes(kind),
    `Bound in src/tools/executors.ts but not class:effect in config/tools.json. ` +
      `The drain never selects it, so it is dead code that looks live.`,
  );
}

// ── a read tool is NOT executable ─────────────────────────────────────────────
// The safety property, asserted rather than trusted: registering a read tool must never make it
// performable through the outbox, or the read/effect split is a naming convention rather than a
// boundary.
for (const tool of allTools().filter((t) => t.class === 'read')) {
  check(
    `read tool "${tool.kind}" is not executable`,
    !isExecutable(tool.kind) && !bound.includes(tool.kind),
    `A read tool must not be reachable by the drain.`,
  );
}

// ── every effect kind the code can EMIT is registered ─────────────────────────
//
// This is the assertion that prevents the stuck row rather than reporting it. It reads the source for
// inserts into `effects` and pulls the literal kind out.
//
// Deliberately a literal-only scan. A computed kind (`kind: someVariable`) is invisible to it, and
// that is stated rather than hidden: the check is a floor, not a proof. It catches the realistic
// case — someone adds a second `kind: 'invoice.create'` insert and forgets the register — which is
// exactly the mistake this whole register exists to make impossible.
const ROOTS = ['src', 'app', 'scripts'];
const EMIT = /\.from\(\s*['"]effects['"]\s*\)[\s\S]{0,400}?kind:\s*['"]([a-z0-9_.]+)['"]/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const emitted = new Map<string, string>();
for (const root of ROOTS) {
  for (const file of sourceFiles(root)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(EMIT)) {
      if (!emitted.has(match[1])) emitted.set(match[1], file);
    }
  }
}

console.log(`      emitted kinds found in source: ${[...emitted.keys()].join(', ') || '(none)'}`);

for (const [kind, file] of emitted) {
  check(
    `emitted kind "${kind}" is registered and executable`,
    isExecutable(kind),
    `${file} inserts an effect of kind "${kind}", which is not class:effect in config/tools.json. ` +
      `It would be written to the outbox and never executed — silently, which is the defect the ` +
      `register exists to end.`,
  );
}

console.log(failures === 0 ? '\nAll tool-register checks passed.' : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
