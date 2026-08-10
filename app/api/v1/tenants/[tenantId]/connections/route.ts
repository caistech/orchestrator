// GET /v1/tenants/:tenantId/connections — what is connected, for the owner's own settings screen.
//
// Kira needs to show "Google Drive — connected as you@example.com, read and write" and cannot read
// this table to find out: `connections` holds refresh tokens for a business's Drive, mail and
// accounting, and the standing rule is that neither product holds the other's service-role key. So
// the fact travels over HTTP and the tokens never do.
//
// NOTHING SECRET IS RETURNED. Not the access token, not the refresh token, not even truncated. A
// status endpoint that leaks a prefix is a status endpoint that leaks; there is no version of this
// screen that needs any part of the credential.
//
// It reports the GRANTED access rather than the requested one, because those differ whenever
// somebody unticks a permission on the consent screen, and the difference is the whole reason an
// owner would look at this page — "connected" reading green while every read comes back empty is
// the failure being prevented.
//
// @machine-callable — called by Kira, not a browser.

import { NextResponse } from 'next/server';

import { serviceClient } from '@/lib/supabase';
import { CONTRACT_VERSION } from '@/src/contract';
import { grantedDriveAccess } from '@/src/connectors/google';
import { grantedContactsAccess } from '@/src/connectors/google-contacts';
import { authoriseCaller } from '@/src/caller-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: { params: Promise<{ tenantId: string }> }) {
  // The tenant is in the PATH here, so it is resolved before the auth check and the caller is
  // authorised against it — a scoped caller must not be able to read or rewrite another business's
  // connections or sender identity just by changing the URL.
  const { tenantId } = await context.params;
  const auth = authoriseCaller(request, tenantId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!UUID.test(tenantId)) return NextResponse.json({ error: 'tenantId must be a UUID' }, { status: 400 });

  const { data, error } = await serviceClient()
    .from('connections')
    // Explicit column list, never `*`. A future column holding something sensitive would otherwise
    // join this response silently, which is exactly how status endpoints start leaking.
    .select('provider, provider_org_name, scopes, connected_at, last_synced_at, revoked_at, last_error')
    .eq('tenant_id', tenantId);

  if (error) {
    console.error('[connections] read failed:', error);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  const connections = (data ?? []).map((row) => ({
    provider: row.provider as string,
    account: (row.provider_org_name as string | null) ?? null,
    /** For google: 'full' | 'readonly' | 'picked' | null. Null means Drive was not granted at all. */
    driveAccess: row.provider === 'google' ? grantedDriveAccess(row.scopes as string | null) : null,
    /** Whether mail was granted, so the settings page can be honest about what Kira can reach. */
    gmail: String(row.scopes ?? '').includes('/auth/gmail.'),
    /**
     * Whether the contact books were granted.
     *
     * Worth its own line on the settings page rather than being folded into "connected". Without it
     * every send addressed by name stops and asks for an address, which the owner experiences as
     * Kira being forgetful rather than as a permission he declined — and the fix is a reconnect he
     * has no reason to think of.
     */
    contacts:
      row.provider === 'google'
        ? grantedContactsAccess(row.scopes as string | null)
        : null,
    connectedAt: row.connected_at as string | null,
    lastSyncedAt: row.last_synced_at as string | null,
    revoked: Boolean(row.revoked_at),
    lastError: (row.last_error as string | null) ?? null,
  }));

  return NextResponse.json({ version: CONTRACT_VERSION, tenantId, connections });
}
