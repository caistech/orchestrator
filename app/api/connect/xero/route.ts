// Start the Xero consent flow.
//
// Operator-initiated (behind the gate), because connecting a business's accounting system is not
// something a machine should be able to trigger on its own.
//
// We reuse the R&D-Tax Xero app's client credentials rather than registering a second app. A Xero
// app accepts MULTIPLE redirect URIs, so this needs one addition in the developer portal, not a new
// registration. The honest trade-offs: the consent screen shows THAT app's name, API rate limits are
// shared between the two products, and rotating that app's secret breaks this one. All acceptable
// while tenant zero is a business we own — and all unacceptable for a distributor product, which
// must have its own app so its clients consent to THEM.

import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { serviceClient, SEED_TENANT } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Read-only where possible: the orchestrator needs to SEE invoices and contacts, not to write them.
// accounting.transactions.read covers invoices; offline_access is what makes a refresh token appear
// at all, and without it the connection dies in 30 minutes.
const SCOPES = 'openid profile email accounting.transactions.read accounting.contacts.read offline_access';

export async function GET(request: Request) {
  const clientId = process.env.XERO_CLIENT_ID;
  const redirectUri = process.env.XERO_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return NextResponse.json({ error: 'XERO_CLIENT_ID / XERO_REDIRECT_URI not configured' }, { status: 503 });
  }

  // A single-use state, stored server-side. Not a signed cookie: the callback must be able to prove
  // this request started here even if the browser dropped the cookie on the round trip through Xero.
  const state = randomBytes(24).toString('hex');
  const tenantId = new URL(request.url).searchParams.get('tenant') ?? SEED_TENANT;
  await serviceClient().from('oauth_states').insert({ state, tenant_id: tenantId, provider: 'xero' });

  const url = new URL('https://login.xero.com/identity/connect/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  return NextResponse.redirect(url.toString());
}
