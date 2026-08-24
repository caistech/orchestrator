// The KIRA project's service-role client.
//
// WHY A SECOND CLIENT EXISTS. Group B remediation moves genuinely privileged operations (admin
// cohort views, Stripe webhook handlers, beta-code claims, global email suppression) out of Kira
// and into this service, because they run in webhook or pre-authentication contexts where no user
// session exists. Those operations read KIRA's tables — `users`, `kira_agents`, `beta_codes`,
// `billing_periods_reported`, `stripe_webhook_events` — so this client points at Kira's Supabase
// project, not ours.
//
// THE CREDENTIAL BOUNDARY. `KIRA_SUPABASE_SERVICE_ROLE_KEY` bypasses RLS on every table in the
// Kira project. It is held HERE and only here: Kira itself is being migrated OFF service-role
// access (Item 2), so the key must never appear in Kira's runtime env again once migration
// completes. Until then both sides may hold it during the transition window.
//
// THROW RATHER THAN FALL BACK, same rule as lib/supabase.ts: a silent downgrade to the anon key
// reads as "the query returned nothing" on every RLS-protected table, which is a very slow bug to
// find. Missing configuration must be loud.

import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function kiraClient(): SupabaseClient {
  if (client) return client;
  const url = process.env.KIRA_SUPABASE_URL;
  const key = process.env.KIRA_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('KIRA_SUPABASE_SERVICE_ROLE_KEY / KIRA_SUPABASE_URL missing');
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}
