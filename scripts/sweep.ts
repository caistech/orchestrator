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
import { XeroSourceConfirmer, xeroConnectionFor } from '../src/connectors/xero';
import type { SourceConfirmer } from '../src/confirm';

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
const ti = process.argv.indexOf('--tenant');
const tenantId = ti > -1 ? process.argv[ti + 1] : SEED_TENANT;
const supabase = createClient(url, key, { auth: { persistSession: false } });

// Use the REAL confirmer wherever the tenant has a live Xero connection. Without this the sweep
// would fall back to DevSourceConfirmer, which reads a seeded `_dev_source_truth` field that real
// Xero rows do not have — so every real invoice would confirm as still-owing by default. That is
// the exact failure the confirm step exists to prevent, arrived at by omission.
const confirmers = new Map<string, SourceConfirmer>();
const connection = await xeroConnectionFor(supabase, tenantId);
if (connection) {
  confirmers.set('xero', new XeroSourceConfirmer(supabase, connection, e.XERO_CLIENT_ID ?? '', e.XERO_CLIENT_SECRET ?? ''));
  console.log('  using LIVE Xero confirmation for this tenant');
}

const report = await sweep({ supabase, tenantId, dryRun, confirmers });

const icon: Record<string, string> = {
  emitted: '→ SENT   ',
  held: '⏸ HELD   ',
  dropped_at_confirm: '✕ DROPPED',
  unreachable: '? UNREACH',
  duplicate: '= DUPE   ',
};

console.log(`\nSweep ${dryRun ? '(DRY RUN — nothing written)' : '(APPLIED)'} · tenant ${tenantId.slice(0, 8)}…\n`);
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
