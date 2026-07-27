// The one service-role client. Server-only: this key bypasses RLS, so it must never reach a bundle.
import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function serviceClient(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Throw rather than fall back to the anon key. A silent downgrade here reads as "the query
  // returned nothing" for every RLS-protected table, which is a very slow bug to find.
  if (!url || !key) throw new Error('SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL missing');
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

export const SEED_TENANT = '00000000-0000-4000-a000-000000000001';
