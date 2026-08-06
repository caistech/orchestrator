// Inspect (and optionally clear) tenants whose from_email points at an UNVERIFIED Resend domain.
//
// WHY THIS EXISTS. contract.ts is explicit that from_email must be set only after Resend reports the
// domain verified, because an unverified domain is rejected at send time. The connector's fallback
// is gated on from_email being ABSENT — so a value that is present but unverifiable sails straight
// past it into a 403, and the task fails after the agent has already told the owner it sent.
//
// That is what happened to updates.factory2key.com.au: DNS was published, the domain was never
// added to Resend (the account is on a 1-domain plan and the slot holds
// updates.corporateaisolutions.com), and from_email was set anyway.
//
//   node --env-file=.env.local scripts/check-tenant-from.mjs
//   node --env-file=.env.local scripts/check-tenant-from.mjs --clear-unverified

import { createClient } from '@supabase/supabase-js';

const CLEAR = process.argv.includes('--clear-unverified');
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const resendKey = process.env.RESEND_API_KEY;
if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');

const sb = createClient(url, key, { auth: { persistSession: false } });

// What Resend will actually accept, straight from the source of truth.
const verified = new Set();
if (resendKey) {
  const res = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${resendKey}` } });
  const body = await res.json();
  for (const d of body?.data ?? []) if (d.status === 'verified') verified.add(String(d.name).toLowerCase());
}
console.log('verified Resend domains:', verified.size ? [...verified].join(', ') : '(none resolved)');

const { data: tenants, error } = await sb
  .from('tenants')
  .select('id, name, legal_name, reply_email, from_email')
  .order('created_at');
if (error) throw new Error(error.message);

const domainOf = (from) => {
  const m = String(from || '').match(/@([^>\s]+)/);
  return m ? m[1].toLowerCase() : null;
};

console.log(`\n${tenants.length} tenant(s):`);
const bad = [];
for (const t of tenants) {
  const domain = domainOf(t.from_email);
  const ok = domain ? verified.has(domain) : null;
  const verdict = t.from_email ? (ok ? 'VERIFIED' : 'NOT VERIFIED — sends will 403') : 'null → falls back (fine)';
  console.log(`  ${String(t.name || t.legal_name || t.id).slice(0, 30).padEnd(32)} ${String(t.from_email || '—').padEnd(46)} ${verdict}`);
  if (t.from_email && !ok) bad.push(t);
}

if (!bad.length) {
  console.log('\nnothing to clear.');
  process.exit(0);
}
if (!CLEAR) {
  console.log(`\n${bad.length} tenant(s) would be cleared — re-run with --clear-unverified`);
  process.exit(0);
}

for (const t of bad) {
  const { error: uErr } = await sb.from('tenants').update({ from_email: null }).eq('id', t.id);
  console.log(`  cleared ${t.name || t.id}: ${uErr ? 'ERR ' + uErr.message : 'now falls back to the portfolio default'}`);
}
