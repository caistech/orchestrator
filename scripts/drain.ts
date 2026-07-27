// Drain the email outbox.
//
//   npm run drain -- --dry-run                 decide, send nothing
//   npm run drain -- --redirect you@real.com   send FOR REAL, but to you
//   npm run drain                              send to the actual recipients
//
// The redirect exists because the dev seed uses @example.invalid addresses on purpose — they are
// unroutable, so without it the transport can only ever be proven by a bounce.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { drainEmailOutbox } from '../src/connectors/email.js';

const SEED_TENANT = '00000000-0000-4000-a000-000000000001';

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
const argv = process.argv;
const dryRun = argv.includes('--dry-run');
const redirectIdx = argv.indexOf('--redirect');
const redirectTo = redirectIdx > -1 ? argv[redirectIdx + 1] : undefined;

if (!e.NEXT_PUBLIC_SUPABASE_URL || !e.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Supabase env missing.');
  process.exit(1);
}
if (!dryRun && !e.RESEND_API_KEY) {
  console.error('RESEND_API_KEY missing — refusing to pretend a send happened.');
  process.exit(1);
}

const supabase = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const report = await drainEmailOutbox({
  supabase,
  tenantId: SEED_TENANT,
  apiKey: e.RESEND_API_KEY ?? '',
  from: e.EMAIL_FROM,
  redirectTo,
  // Absent on purpose: no unsubscribe route is hosted yet, so commercial mail must be refused.
  unsubscribeBaseUrl: e.UNSUBSCRIBE_BASE_URL,
  dryRun,
});

console.log(`\nOutbox drain ${dryRun ? '(DRY RUN)' : redirectTo ? `(LIVE → redirected to ${redirectTo})` : '(LIVE)'}\n`);
for (const d of report.details) {
  console.log(`  ${d.outcome.padEnd(11)} ${d.subject.slice(0, 46).padEnd(48)} ${d.detail ?? ''}`);
}
console.log(`\n  claimed ${report.claimed} · sent ${report.sent} · failed ${report.failed} · refused ${report.refused}\n`);
