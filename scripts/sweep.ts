// Run the sweep against the seeded tenant and print what it decided.
//
//   npm run sweep -- --dry-run     decide everything, write nothing
//   npm run sweep                  write tasks, drafts, approvals and effects
//
// The dry run is the one to reach for while developing: it exercises every threshold, every confirm
// and every gate decision without leaving rows behind, so it can be run as often as you like.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { sweep } from '../src/sweeper';

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

const dryRun = process.argv.includes('--dry-run');
const supabase = createClient(url, key, { auth: { persistSession: false } });

const report = await sweep({ supabase, tenantId: SEED_TENANT, dryRun });

const icon: Record<string, string> = {
  emitted: '→ SENT   ',
  held: '⏸ HELD   ',
  dropped_at_confirm: '✕ DROPPED',
  unreachable: '? UNREACH',
  duplicate: '= DUPE   ',
};

console.log(`\nSweep ${dryRun ? '(DRY RUN — nothing written)' : '(APPLIED)'} · tenant ${SEED_TENANT.slice(0, 8)}…\n`);
for (const o of report.outcomes) {
  console.log(
    `  ${icon[o.verdict]}  flow ${o.flow.padEnd(4)} ${o.entity.slice(0, 32).padEnd(34)}` +
      `${(o.band ?? '').padEnd(22)}${o.detail ?? ''}`,
  );
}
console.log(
  `\n  candidates ${report.candidates} · emitted ${report.emitted} · held ${report.held} · ` +
    `dropped-at-confirm ${report.droppedAtConfirm} · unreachable ${report.unreachable} · dupes ${report.duplicates}\n`,
);
