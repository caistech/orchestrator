// Run the async agent workers — the CLI face of the doing-layer.
//
//   npm run agents                    process all agent-dispatched tasks, then exit
//   npm run agents -- --dry-run       decide, mutate nothing
//
// The work lives in src/agents/worker.ts (`runAgentWorker`); this file is only the hosting —
// env loading and the CLI flag. The cron route (app/api/cron/agents) calls the SAME function,
// so a script and a schedule can never drift. Mirrors scripts/sweep.ts.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

import { runAgentWorker } from '../src/agents/worker';

const fileEnv = (() => {
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
    return {};
  }
})();

const e = { ...fileEnv, ...process.env } as Record<string, string>;
const apply = !process.argv.includes('--dry-run');

if (!e.NEXT_PUBLIC_SUPABASE_URL || !e.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Supabase env missing.');
  process.exit(1);
}

const supabase = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const report = await runAgentWorker({
  supabase,
  apiKey: e.OPENAI_API_KEY ?? '',
  apply,
});

console.log(`[agents] ${report.processed} task(s) processed`);
for (const run of report.runs) {
  console.log(
    `  ${run.status} ${run.agentId} on ${run.taskId} (${run.iterations} iter, $${run.totalCost.toFixed(4)}${run.effectKind ? ', effect ' + run.effectKind : ''})`,
  );
}
if (report.stagedEvidence > 0 || report.evidenceErrors > 0) {
  console.log(`[evidence] ${report.stagedEvidence} staged, ${report.evidenceErrors} errors`);
}
for (const r of report.ratchets) {
  console.log(`[ratchet] ${r.key}: ${r.currentBand} → ${r.effectiveBand} (${r.reason})`);
}
console.log(apply ? '[agents] done' : '[agents] dry run — nothing mutated');