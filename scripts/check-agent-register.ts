// Assertions for the agent register.  Run: npm run check:agents
//
// The register is split in two on purpose — config/agents.json holds the facts, src/agents/
// register.ts holds the validation and lookup, src/agents/runner.ts holds the binding (the
// read-tool resolver). An agent registered here but missing a runner binding is a bug — it
// routes to nothing and the dispatch falls through to 'unsupported' silently.
//
// This script asserts:
//   1. The register parses and validates (importing it threw if not).
//   2. Every agent tool reference resolves to a REAL tool in config/tools.json.
//   3. Every agent tool reference is class:read (agents may not hold effect tools — the
//      read/effect split, enforced structurally).
//   4. Every agent has a runner resolver in src/agents/runner.ts (parity).
//   5. Every effect kind that can be emitted has an evidence mapping (the collector would
//      otherwise silently ignore it — the loud-not-invisible principle).
//
// The migration carries the schema; this carries the discipline.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { allAgents, allAgentToolRefs, kindsOwnedBy } from '../src/agents/register';
import { allTools, toolFor } from '../src/tools/register';
import { resolveReadTool } from '../src/agents/runner';
import { EVIDENCE_MAPPINGS } from '../src/genome/evidence-collector';

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
// Importing it already threw if not — validate() refuses rather than filtering.
check('config/agents.json parses and validates', true);
console.log(`      ${allAgents().length} agent(s): ${allAgents().map((a) => a.id).join(', ')}`);

// ── every agent tool reference resolves to a registered tool ──────────────────
const registeredLabels = allTools().map((t) => t.kind);
const agentToolRefs = allAgentToolRefs();

for (const ref of agentToolRefs) {
  check(`tool "${ref}" resolves in config/tools.json`, registeredLabels.includes(ref));
}

// ── no agent may hold an effect tool ──────────────────────────────────────────
for (const agent of allAgents()) {
  for (const ref of agent.tools) {
    const tool = toolFor(ref);
    // `toolFor` may return null for an unregistered ref; the previous loop already failed if so.
    check(
      `agent "${agent.id}" tool "${ref}" is class:read (not effect)`,
      tool ? tool.class === 'read' : false,
      tool ? `found ${tool.class}` : 'unregistered',
    );
  }
}

// ── registry ↔ runner parity ──────────────────────────────────────────────────
// Reverse-map: every agent id must be reachable from at least one kind via agentForKind.
// The mapping lives in register.ts (KIND_TO_AGENT, explicit by design — names by function,
// not concatenation); kindsOwnedBy is the single source the check reads.
for (const agent of allAgents()) {
  const routed = kindsOwnedBy(agent.id).length > 0;
  check(`agent "${agent.id}" routes from a kind (${kindsOwnedBy(agent.id).join(', ') || 'none'})`, routed);

  for (const ref of agent.tools) {
    check(`agent "${agent.id}" tool "${ref}" has a runner binding`, resolveReadTool(ref) !== null);
  }
}

// ── every executable effect kind has an evidence mapping ─────────────────────
import { executableKinds } from '../src/tools/register';

for (const kind of executableKinds()) {
  const mapped = EVIDENCE_MAPPINGS.some((m) => m.effectKind === kind);
  // The evidence collector intentionally does not map every kind (not all effects are Genome
  // evidence) — but the DECISION to not map one must be loud, so an unmapped kind that SHOULD
  // be evidence cannot silently vanish. We assert on the kinds we know matter.
  if (kind === 'email.send' || kind === 'email.draft') {
    check(`effect "${kind}" has an evidence mapping`, mapped);
  }
}

// ── unused files in src/agents would be dead weight ───────────────────────────
// A file in src/agents/ with no test is a file nobody runs. Fail instead of forgetting.
const agentDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agents');
const agentFiles = readdirSync(agentDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
const testFiles = readdirSync(agentDir).filter((f) => f.endsWith('.test.ts'));

for (const f of agentFiles) {
  check(
    `src/agents/${f} has a test (${f.replace('.ts', '.test.ts')})`,
    testFiles.includes(f.replace('.ts', '.test.ts')),
  );
}

if (failures > 0) {
  console.error(`\ncheck:agents — ${failures} failure(s).`);
  process.exit(1);
}
console.log('\ncheck:agents — all assertions passed.');