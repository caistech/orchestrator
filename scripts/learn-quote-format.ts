// Learn how a tenant writes a quote, from their own past quotes.  Flow 16, the standing fact.
//
//   npm run learn:quotes -- --tenant <uuid> --dry-run          decide, write nothing
//   npm run learn:quotes -- --tenant <uuid>                     extract and store as a new version
//   npm run learn:quotes -- --tenant <uuid> --folder <driveId>  when their quotes are named by job number
//   npm run learn:quotes -- --tenant <uuid> --show              print the stored format, read nothing
//
// DRY RUN IS THE DEFAULT POSTURE for anything touching a real business, per the sweep and drain
// scripts. This one only reads Drive and writes one row, so it is less dangerous than those — but it
// is worth seeing what was extracted before it becomes the thing every future quote imitates. A bad
// format is not loud: it produces quotes that are subtly not theirs.

import { createClient } from '@supabase/supabase-js';

import {
  currentQuoteFormat,
  learnQuoteFormat,
  saveQuoteFormat,
  formatAsInstructions,
} from '../src/knowledge/quote-format';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const tenantId = arg('tenant');
  if (!tenantId) {
    console.error('Usage: npm run learn:quotes -- --tenant <uuid> [--dry-run] [--folder <id>] [--show]');
    process.exitCode = 2;
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
    process.exitCode = 2;
    return;
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  if (flag('show')) {
    const stored = await currentQuoteFormat(supabase, tenantId);
    if (!stored) {
      console.log('No quote format stored for this tenant — quotes will be drafted generically.');
      return;
    }
    console.log(`Quote format v${stored.version}, extracted ${stored.extractedAt}`);
    console.log(`Confirmed: ${stored.confirmedAt ?? 'not yet — extracted, not agreed by a human'}`);
    console.log(`Learned from: ${stored.sourceFiles.map((f) => f.name).join(', ') || '(no provenance recorded)'}`);
    console.log('\n--- as the drafter sees it ---');
    console.log(formatAsInstructions(stored));
    return;
  }

  const result = await learnQuoteFormat(supabase, tenantId, {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    folderId: arg('folder'),
  });

  if (!result.ok) {
    // Each failure names the DIFFERENT thing to do about it. "Could not extract" would collapse
    // four distinct fixes into one shrug.
    console.error(`\nNo format learned — ${result.failure}\n  ${result.detail}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Learned from ${result.sources.length} quote(s):`);
  for (const f of result.sources) console.log(`  · ${f.name}${f.modifiedTime ? `  (${f.modifiedTime.slice(0, 10)})` : ''}`);
  console.log('\n--- extracted format ---');
  console.log(JSON.stringify(result.format, null, 2));

  if (flag('dry-run')) {
    console.log('\nDRY RUN — nothing written. Re-run without --dry-run to store this as a new version.');
    return;
  }

  const { version } = await saveQuoteFormat(supabase, tenantId, result);
  console.log(`\nStored as version ${version}. Quotes for this tenant will now be drafted in their format.`);
  console.log('It is EXTRACTED, not confirmed — have the owner read it before telling him it is his.');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
