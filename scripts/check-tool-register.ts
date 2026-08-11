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
// This is the assertion that prevents the stuck row rather than reporting it. The runtime drain
// reports an unregistered kind, but by then the effect is already written and already stuck.
//
// ⚠️ WIDENED 2026-08-12, BECAUSE THE FIRST VERSION HAD A HOLE AND THE VERY NEXT CHANGE FELL IN IT.
//
// It matched `kind:` followed IMMEDIATELY by a quoted literal. The approve route then began emitting
//     kind: delivery === 'draft' ? 'email.draft' : 'email.send'
// and `email.draft` became invisible to the scan — silently, while the check still reported green.
// The original was documented as "a floor, not a proof", which turned out to be worth very little:
// the hole was real within hours.
//
// It now reads the whole `kind:` EXPRESSION and takes every string literal in it. That introduces the
// opposite risk — 'draft' in the comparison above is a literal and is NOT a kind — so it keeps only
// literals containing a DOT, which `register.ts` enforces on every registered kind for exactly this
// reason. Precise without a parser.
//
// A kind that is genuinely computed (`kind: someVariable`) still cannot be verified statically. That
// now FAILS rather than passing quietly, and opts out by name with a reason on the same line:
//     kind: computed, // @effect-kind-dynamic: resolved from the register at runtime
const ROOTS = ['src', 'app', 'scripts'];
/** The `effects` insert, then the whole `kind:` line — the expression, not just a literal. */
const EMIT = /\.from\(\s*['"]effects['"]\s*\)[\s\S]{0,400}?kind:\s*([^\n]+)/g;
/** A kind is noun.verb. The dot is what separates it from any other string on the line. */
const KIND_LITERAL = /['"]([a-z0-9_]+\.[a-z0-9_.]+)['"]/g;
const DYNAMIC_OPT_OUT = /@effect-kind-dynamic:\s*\S/;

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
/** Emit sites whose kind is an expression with no literal in it — unverifiable, so reported. */
const unverifiable: Array<{ file: string; expression: string }> = [];

for (const root of ROOTS) {
  for (const file of sourceFiles(root)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(EMIT)) {
      const expression = match[1].trim();
      const literals = [...expression.matchAll(KIND_LITERAL)].map((m) => m[1]);

      if (literals.length === 0) {
        // Opting out is allowed, but it has to be written down and it has to say why — the same
        // "silence is not acceptance" shape as the canonical-feed guard.
        if (!DYNAMIC_OPT_OUT.test(expression)) unverifiable.push({ file, expression });
        continue;
      }
      for (const kind of literals) if (!emitted.has(kind)) emitted.set(kind, file);
    }
  }
}

console.log(`      emitted kinds found in source: ${[...emitted.keys()].join(', ') || '(none)'}`);

for (const site of unverifiable) {
  check(
    `emit site in ${site.file} names a kind that can be checked`,
    false,
    `\`kind: ${site.expression.slice(0, 80)}\` has no string literal, so nothing here can prove the ` +
      `kind is registered — and an unregistered kind is written to the outbox and never executed. ` +
      `Use a literal, or opt out on the same line with "// @effect-kind-dynamic: <why>".`,
  );
}

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
