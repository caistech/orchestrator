// Does flow 13's lookup actually return rows?  Run: npm run probe:pricing
//
// The unit tests cover the pure edges — term extraction, formatting, the refusal instruction — and
// they pass against an empty result exactly as happily as against a full one. So the query itself,
// which is the whole tool, had never returned a single row when it shipped. A `.or()` filter with
// escaped LIKE metacharacters is either exactly right or silently returns nothing, and "silently
// returns nothing" is indistinguishable from "this business has no history".
//
// READ-ONLY. It runs the real function against the seeded dev tenant and asserts what comes back.
// Nothing is written. Safe against any tenant, but pointless against one with no priced entities.

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

import { findComparableWork, comparablesAsContext } from '../src/knowledge/past-pricing';
import { findMaterialCost, materialCostAsContext } from '../src/knowledge/material-cost';

const SEED_TENANT = '00000000-0000-4000-a000-000000000001';

function env(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync('.env.local', 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
        }),
    );
  } catch {
    return process.env as Record<string, string>;
  }
}

const e = { ...env(), ...process.env };
const url = e.NEXT_PUBLIC_SUPABASE_URL;
const key = e.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env.local or env).');
  process.exit(1);
}

const ti = process.argv.indexOf('--tenant');
const tenantId = ti > -1 ? process.argv[ti + 1] : SEED_TENANT;
const supabase = createClient(url, key, { auth: { persistSession: false } });

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) console.log(`ok    ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

async function main() {
  console.log(`tenant ${tenantId}\n`);

  // What is even in there? Without this, a zero result below is ambiguous between "the query is
  // wrong" and "there is nothing to find", which is the exact ambiguity this probe exists to remove.
  const { data: stock } = await supabase
    .from('entities')
    .select('kind, display_name, attributes')
    .eq('tenant_id', tenantId)
    .in('kind', ['quote', 'invoice', 'job']);
  console.log(`priced entities present: ${stock?.length ?? 0}`);
  for (const row of stock ?? []) {
    const amount = (row.attributes as Record<string, unknown>)?.amount;
    console.log(`  ${String(row.kind).padEnd(8)} ${row.display_name}  ${amount ?? '(no amount)'}`);
  }
  console.log('');

  if (!stock?.length) {
    // exitCode + return, never process.exit(): with a supabase fetch still closing, process.exit()
    // aborts on a libuv assertion and reports 127 "crashed" instead of 1 "found a problem".
    console.error('nothing priced for this tenant — the probe cannot prove anything. Seed it first.');
    process.exitCode = 1;
    return;
  }

  // 1 — the real path: a client name the index knows.
  const byClient = await findComparableWork(supabase, tenantId, {
    client: 'Ellis Plumbing',
    description: 'quote Ellis Plumbing for the plumbing work',
  });
  check('a known client returns prior work', byClient.length > 0, `got ${byClient.length} rows`);
  for (const c of byClient) console.log(`      → ${c.label}  ${c.amount ?? '(none)'}  ${c.source ?? ''}`);

  check(
    'the amount comes back as a number, not a string or null',
    byClient.some((c) => typeof c.amount === 'number'),
    'every row had a null/non-numeric amount — the attributes read is wrong',
  );

  // 2 — the negative. A business we have never worked for must return nothing rather than
  // everything, which is what a broken OR filter does.
  const unknown = await findComparableWork(supabase, tenantId, {
    client: 'Zzzz Nonexistent Holdings',
    description: 'quote Zzzz Nonexistent Holdings for the widget installation',
  });
  check('an unknown client returns nothing', unknown.length === 0, `got ${unknown.length} rows — the filter is not filtering`);

  // 3 — the escaping. A client literally called "50%" must not match every row: in LIKE, an
  // unescaped % is "anything". This is the failure that looks like a suspiciously rich history.
  const wildcard = await findComparableWork(supabase, tenantId, { client: '%' });
  check(
    'a bare % does not match everything',
    wildcard.length === 0,
    `got ${wildcard.length} rows — LIKE metacharacters are reaching the query unescaped`,
  );

  // 4 — no search terms at all must not become "select everything".
  const empty = await findComparableWork(supabase, tenantId, { client: null, description: '' });
  check('no usable terms returns nothing', empty.length === 0, `got ${empty.length} rows`);

  // 5 — the refusal instruction survives the round trip to the database and back.
  const context = comparablesAsContext(byClient);
  check('the rendered context carries the refusal', !!context && /NOT the price/i.test(context));
  if (context) console.log(`\n--- what the drafter would be shown ---\n${context}\n`);

  // ── FLOW 14a — material costs, which live inside a jsonb ARRAY rather than a column ───────────
  // Same failure shape as the .or() filter above, one layer deeper: a jsonb path that is subtly
  // wrong returns nothing, and nothing is indistinguishable from "this business has never bought
  // that". The unit tests cannot see it, because they never touch a database.
  const { data: bills } = await supabase
    .from('entities')
    .select('display_name')
    .eq('tenant_id', tenantId)
    .eq('kind', 'bill');
  console.log(`supplier bills present: ${bills?.length ?? 0}`);

  if (!bills?.length) {
    check('supplier bills are seeded', false, 'no bill entities — flow 14a cannot be proven');
  } else {
    const pine = await findMaterialCost(supabase, tenantId, 'quote the deck in treated pine');
    check('a known material returns what we paid', pine.length > 0, `got ${pine.length} line items`);
    for (const m of pine) console.log(`      → ${m.description}  ${m.unitAmount ?? '(none)'}  ${m.supplier ?? ''}`);

    // Both seeded suppliers sell treated pine. One supplier back means the scan stopped at the
    // first bill, which would silently halve every answer.
    check(
      'it reaches across bills, not just the first',
      new Set(pine.map((m) => m.supplier)).size > 1,
      'every hit came from one supplier — the scan is stopping early',
    );

    const none = await findMaterialCost(supabase, tenantId, 'quote for unobtanium flanges');
    check('an unknown material returns nothing', none.length === 0, `got ${none.length}`);

    const costContext = materialCostAsContext(pine);
    check(
      'the cost context says COSTS and forbids quoting at cost',
      !!costContext && /COSTS, not prices/.test(costContext) && /give the job away/i.test(costContext),
    );
    if (costContext) console.log(`\n--- what the drafter would be shown for materials ---\n${costContext}\n`);
  }

  console.log(failures === 0 ? 'All probes passed.' : `\n${failures} probe(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
