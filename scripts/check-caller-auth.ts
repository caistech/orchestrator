// Assertions for the caller/tenant authorisation boundary.  Run: npx tsx scripts/check-caller-auth.ts
//
// Written as a tsx script rather than a vitest suite on purpose: this repo has no test runner and no
// `test` script — `src/jurisdiction.test.ts` imports vitest, which is not installed, so it has never
// once run. Adding a framework is a decision for the repo owner; leaving a security boundary with
// zero executable checks is not a decision anyone would make deliberately. tsx is already a
// dependency, so this runs today.
//
// What it guards: before this, one shared secret vouched for ANY tenant, and the caller simply
// stated which tenant it was acting for. That is coherent with a single trusted caller and becomes a
// cross-tenant hole the moment there are two — which is exactly what wiring F2K-Checkpoint in does.

import { authoriseCaller, parseCallers } from '../src/caller-auth';

const HEADER = 'x-orchestrator-secret';
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

let failures = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.error(`FAIL  ${name}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok    ${name}`);
  }
}

function req(secret?: string): Request {
  return new Request('https://orchestrator.test/v1/tasks', {
    headers: secret ? { [HEADER]: secret } : {},
  });
}

function status(result: ReturnType<typeof authoriseCaller>): number | 'ok' {
  return result.ok ? 'ok' : result.status;
}

const SCOPED = {
  ORCHESTRATOR_CALLERS: JSON.stringify([{ id: 'f2k', secret: 'f2k-secret', tenants: [TENANT_A] }]),
} as NodeJS.ProcessEnv;

const LEGACY = { ORCHESTRATOR_SECRET: 'legacy-secret' } as NodeJS.ProcessEnv;

// ── fail-closed on configuration ───────────────────────────────────────────────
check('no callers configured refuses', status(authoriseCaller(req('anything'), TENANT_A, {} as NodeJS.ProcessEnv)), 503);
check(
  'malformed registry refuses rather than emptying',
  status(authoriseCaller(req('x'), TENANT_A, { ORCHESTRATOR_CALLERS: 'not json' } as NodeJS.ProcessEnv)),
  503,
);

// ── identity ───────────────────────────────────────────────────────────────────
check('missing header is 401', status(authoriseCaller(req(), TENANT_A, SCOPED)), 401);
check('wrong secret is 401', status(authoriseCaller(req('nope'), TENANT_A, SCOPED)), 401);
check('correct secret is allowed', status(authoriseCaller(req('f2k-secret'), TENANT_A, SCOPED)), 'ok');

// ── the actual point: tenant scope ─────────────────────────────────────────────
check(
  'scoped caller CANNOT act for another tenant',
  status(authoriseCaller(req('f2k-secret'), TENANT_B, SCOPED)),
  403,
);
check('legacy wildcard caller may act for any tenant', status(authoriseCaller(req('legacy-secret'), TENANT_B, LEGACY)), 'ok');

// ── the seed-tenant defect ─────────────────────────────────────────────────────
// dispatch used to read `body.tenantId || SEED_TENANT`, so a request with no tenant succeeded and
// landed a real business's task in a dev fixture. Blank must refuse, at the boundary, every time.
check('absent tenant is 400', status(authoriseCaller(req('f2k-secret'), undefined, SCOPED)), 400);
check('blank tenant is 400', status(authoriseCaller(req('f2k-secret'), '   ', SCOPED)), 400);
check(
  'tenant-less endpoints opt in explicitly with null',
  status(authoriseCaller(req('f2k-secret'), null, SCOPED)),
  'ok',
);

// ── registry parsing ───────────────────────────────────────────────────────────
check('legacy secret registers as a wildcard caller', parseCallers(LEGACY).map((c) => [c.id, c.tenants]), [['legacy', '*']]);
check(
  'both sources register together',
  parseCallers({ ...SCOPED, ...LEGACY } as NodeJS.ProcessEnv).map((c) => c.id),
  ['f2k', 'legacy'],
);

console.log(failures === 0 ? '\nAll caller-auth checks passed.' : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
