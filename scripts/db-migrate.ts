// Apply this repo's SQL to a database, after PROVING which database it is.
//
//   npm run db:migrate -- --ref <ref> --expect "orchestrator"            dry run
//   npm run db:migrate -- --ref <ref> --expect "orchestrator" --apply    apply
//   npm run db:seed    -- --ref <ref> --expect "orchestrator-ci" --apply seed fixtures
//
// WHY A NAME GUARD RATHER THAN A REF. The portfolio runs 35 Supabase projects and a migration
// pushed at the wrong one may not error — it just lands somewhere else, and idempotent SQL will not
// complain. Checking a ref against the ref you typed proves nothing: it is the same string twice.
// So this fetches the project and refuses unless its NAME matches what the caller expected.
//
// WHY IT EXISTS AT ALL. Migrations here were applied by hand, one at a time, through the Management
// API. That is fine while a person is doing it and impossible for CI, which has to bring an empty
// database up to date before it can test anything against it. `db/008` was applied by hand today;
// the ninth should not be.
//
// SEED IS A SEPARATE VERB, deliberately. `002_seed_dev.sql` DELETEs and re-INSERTs fixture rows, and
// a runner that swept it in with the schema would make "bring the database up to date" quietly
// destructive. Migrations are everything that is not seed; seed is opted into by name.

import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = 'db';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes('--apply');
const SEED_MODE = process.argv.includes('--seed');

const ref = arg('ref') ?? process.env.SUPABASE_PROJECT_REF;
const expected = arg('expect') ?? process.env.SUPABASE_PROJECT_NAME;

if (!ref || !expected) {
  console.error('usage: db-migrate --ref <ref> --expect "<project name>" [--seed] [--apply]');
  console.error('       (or SUPABASE_PROJECT_REF + SUPABASE_PROJECT_NAME in env)');
  process.exit(2);
}

function token(): string {
  const fromEnv = process.env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_MANAGEMENT_TOKEN;
  if (fromEnv) return fromEnv.trim();
  try {
    return readFileSync(join(homedir(), '.supabase-token'), 'utf8').trim();
  } catch {
    console.error('no Supabase token — set SUPABASE_ACCESS_TOKEN or place one at ~/.supabase-token');
    process.exit(2);
  }
}

const TOKEN = token();
const api = (path: string, init?: RequestInit) =>
  fetch(`https://api.supabase.com/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });

const query = async (sql: string) => {
  const res = await api(`/projects/${ref}/database/query`, { method: 'POST', body: JSON.stringify({ query: sql }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
};

/** Seed files are named for what they are. Everything else is schema. */
const isSeed = (file: string) => /seed/i.test(file);

/**
 * Every failure path below sets `process.exitCode` and RETURNS rather than calling `process.exit()`.
 *
 * `process.exit()` with fetch handles still closing aborts Node with a libuv assertion and reports
 * **127 — crashed** where **1 — found a problem** was meant. A CI step that refuses to touch the
 * wrong database would therefore be indistinguishable from one that fell over, which is exactly the
 * kind of misreported failure this script exists to prevent. Recorded portfolio-wide in
 * SHARED_SERVICES.md against `portfolio-gate`'s sibling-parity bin; walked into again here.
 */
async function main() {
  const projRes = await api(`/projects/${ref}`);
  if (!projRes.ok) {
    console.error(`could not read project ${ref}: ${projRes.status} ${(await projRes.text()).slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }
  const project = (await projRes.json()) as { name: string; region: string };
  console.log(`target : ${project.name}  (${ref}, ${project.region})`);

  if (project.name !== expected) {
    console.error(`\nREFUSING: expected "${expected}", got "${project.name}". Wrong database.`);
    process.exitCode = 1;
    return;
  }

  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => (SEED_MODE ? isSeed(f) : !isSeed(f)))
    .sort(); // 001, 002, … — lexical order IS the intended order, which is why they are numbered.

  console.log(`${SEED_MODE ? 'seed' : 'schema'} : ${files.length} file(s)`);
  for (const f of files) console.log(`  ${f}`);

  const before = await query(
    `select count(*)::int as n from information_schema.tables where table_schema='public'`,
  );
  console.log(`before : ${before?.[0]?.n ?? '?'} tables in public`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
    return;
  }

  for (const f of files) {
    const sql = readFileSync(join(DIR, f), 'utf8');
    try {
      await query(sql);
      console.log(`  applied  ${f}`);
    } catch (err) {
      // Stop at the first failure. Continuing would apply later migrations against a schema that is
      // not what they were written for, and the second error would be a consequence of the first
      // rather than a finding.
      console.error(`  FAILED   ${f}\n    ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }

  const after = await query(
    `select count(*)::int as n from information_schema.tables where table_schema='public'`,
  );
  console.log(`after  : ${after?.[0]?.n ?? '?'} tables in public`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
