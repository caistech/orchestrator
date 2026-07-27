// Xero consent callback — exchange the code, record the connection.
//
// @machine-callable in the sense that Xero redirects a browser here; the middleware must not gate it
// or the consent round trip cannot complete.

import { NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const denied = url.searchParams.get('error');

  if (denied) return html(`Xero declined the connection: ${denied}`, 400);
  if (!code || !state) return html('Missing code or state.', 400);

  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const redirectUri = process.env.XERO_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return html('Xero is not configured.', 503);

  const supabase = serviceClient();

  // Consume the state exactly once. An unconsumed state left lying around is a replayable token; a
  // state that cannot be consumed means this callback did not originate from our redirect.
  const { data: st } = await supabase
    .from('oauth_states')
    .update({ consumed_at: new Date().toISOString() })
    .eq('state', state)
    .is('consumed_at', null)
    .select('tenant_id')
    .maybeSingle();
  if (!st) return html('That authorisation link has already been used, or did not come from here.', 400);

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenRes = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  });
  if (!tokenRes.ok) return html(`Token exchange failed: ${(await tokenRes.text()).slice(0, 200)}`, 502);
  const tok = await tokenRes.json() as { access_token: string; refresh_token: string; expires_in: number; scope?: string };

  // Which Xero organisation(s) did they actually grant? A user with several picks one at consent,
  // and the id they picked is the only one our API calls will work against.
  const orgsRes = await fetch('https://api.xero.com/connections', {
    headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' },
  });
  const orgs = orgsRes.ok ? await orgsRes.json() as any[] : [];
  const org = orgs[0];
  if (!org) return html('Xero returned no organisation for this authorisation.', 502);

  await supabase.from('connections').upsert({
    tenant_id: st.tenant_id,
    provider: 'xero',
    provider_org_id: org.tenantId,
    provider_org_name: org.tenantName,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
    scopes: tok.scope ?? null,
    revoked_at: null,
    last_error: null,
  }, { onConflict: 'tenant_id,provider,provider_org_id' });

  return html(`Connected to <strong>${escapeHtml(org.tenantName)}</strong>. Invoices will sync on the next run.`);
}

function html(message: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<body style="font:16px/1.55 system-ui;max-width:34rem;margin:12vh auto;padding:0 1.25rem">` +
    `<h1 style="font-size:1.25rem">Xero</h1><p>${message}</p><p><a href="/queue">Back to the queue</a></p></body>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}
function escapeHtml(s: string) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
