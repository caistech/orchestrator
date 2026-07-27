// Pull a tenant's Xero invoices into the entity index.
//
//   npm run xero:sync -- --tenant <uuid>
//
// This writes a PROJECTION, not a record. Everything it lands is stale the moment it lands, which is
// why nothing downstream may act on it without XeroSourceConfirmer asking Xero again.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { syncInvoices, xeroConnectionFor } from '../src/connectors/xero';

const env = { ...(() => { try {
  return Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
} catch { return {}; } })(), ...process.env } as Record<string, string>;

const idx = process.argv.indexOf('--tenant');
const tenantId = idx > -1 ? process.argv[idx + 1] : '11111111-1111-4111-a111-111111111111';

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const connection = await xeroConnectionFor(supabase, tenantId);
if (!connection) {
  console.error(`No live Xero connection for tenant ${tenantId}. Visit /api/connect/xero first.`);
  process.exit(1);
}

const result = await syncInvoices(supabase, connection, env.XERO_CLIENT_ID, env.XERO_CLIENT_SECRET);
console.log(`\nSynced ${result.upserted} invoice(s) into the entity index for tenant ${tenantId.slice(0, 8)}…\n`);

// Show what landed, so the projection is inspectable rather than a black box.
const { data } = await supabase
  .from('entities')
  .select('display_name, days_overdue, email, attributes')
  .eq('tenant_id', tenantId)
  .eq('kind', 'invoice')
  .order('days_overdue', { ascending: false })
  .limit(15);

for (const e of data ?? []) {
  const amt = (e.attributes as { amount?: number })?.amount ?? 0;
  const overdue = e.days_overdue ?? 0;
  console.log(
    `  ${String(overdue).padStart(5)}d  ${amt.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' }).padStart(12)}  ` +
      `${String(e.display_name).slice(0, 40).padEnd(42)}${e.email ?? '(no email)'}`,
  );
}
console.log('\n  (negative days = not yet due)\n');
