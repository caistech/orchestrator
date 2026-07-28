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
// Overridable, because which scopes an app may request is a property of the APP registration, not of
// this code — and discovering that costs a failed consent round trip each time.
//
// XERO IS MID-MIGRATION FROM BROAD SCOPES TO GRANULAR ONES, and that is the whole story behind the
// invalid_scope failure. Apps created after 2 March 2026 get ONLY the granular scopes; apps created
// before keep the broad ones until September 2027. So the correct scope name now depends on when the
// app was registered, which is not something the code can infer.
//
// `accounting.transactions` is BROAD and has no granular equivalent by that name — invoices moved to
// `accounting.invoices`. Probing the authorize endpoint scope by scope made the split visible:
//   accounting.contacts / .read       accepted   (exists in BOTH schemes)
//   accounting.settings.read          accepted   (exists in both)
//   accounting.transactions / .read   REJECTED   (broad only)
//   accounting.reports.read           REJECTED   (broad only; granular is reports.<name>.read)
//
// Same cause makes R&D-Tax's integration unusable: it asks a post-March app for a pre-March scope.
//
// NOT `app.connections`, even though the authorize endpoint accepts it. It is a NON-TENANTED scope,
// and Xero's docs are explicit that those work only with the Client Credentials grant — we use
// authorization_code, where `/connections` is readable with the plain access token. Requesting it
// here asks a user to consent to something that does nothing, which is the opposite of the minimum
// scope the same docs ask for.
// PROBED, NOT GUESSED (2026-07-28). The authorize endpoint answers a bad scope with a redirect to
// /identity/error and a good one with a redirect to /identity/user/login, so each candidate can be
// tested without a consent round trip. A control scope that cannot exist
// (accounting.notathing.read) was rejected, which is what makes the accepted ones meaningful.
//
//   accounting.settings.read                    accepted  → /Organisation, and the bank ACCOUNT list
//   accounting.reports.profitandloss.read       accepted  → the P&L report
//   accounting.reports.banksummary.read         accepted  → the balances themselves
//   accounting.reports.bankSummary.read         REJECTED  ← same scope, camelCase. This one cost an
//                                                            hour: it reads as 'no such capability'
//                                                            when it is a spelling.
//   accounting.reports.read                     REJECTED  (broad-only; this app is post-March)
//   accounting.transactions.read                REJECTED  (broad-only)
//
// GRANULAR SCOPES ARE LOWERCASE. Xero's own docs render several of them camelCase, and the endpoint
// disagrees. When a scope looks like it should exist and does not, try the casing before concluding
// the capability is unavailable.
//
// ⚠️ WIDENING THIS LIST DOES NOTHING FOR AN EXISTING CONNECTION. Scopes are fixed at consent, so a
// business that has already connected must go through it again to gain them — the refresh token
// carries what it was granted, not what we now ask for.
const SCOPES =
  process.env.XERO_SCOPES ??
  [
    'openid',
    'profile',
    'email',
    'accounting.invoices.read',
    'accounting.contacts.read',
    'accounting.settings.read',
    'accounting.reports.profitandloss.read',
    'accounting.reports.banksummary.read',
    'offline_access',
  ].join(' ');

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
