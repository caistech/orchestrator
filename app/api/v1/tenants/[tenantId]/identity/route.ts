// PUT /v1/tenants/:tenantId/identity — the only thing that lifts the send refusal.
//
// A tenant that arrives through /v1/dispatch is provisioned from nothing but an id and a display
// name, because that is all a dispatched task carries. It therefore has no legal identity, and the
// email connector refuses to send on its behalf — correctly, because the Spam Act footer must name
// the TENANT (a plumbing business chasing its own customer), and the two ways to degrade are mail
// with no identification at all or mail carrying Corporate AI Solutions' ABN on someone else's
// debt-chase. The second is worse: it is confidently wrong.
//
// So the identity has to arrive some other way, and this is it.
//
// WHY A SEPARATE CALL, NOT FIELDS ON DispatchRequest.context.
//
// Whose name is on the email is a decision, made once, by a human who confirmed it against the
// register. Carried on every dispatch it becomes a value that can drift — a stale client cache, a
// misclassified utterance, a second browser tab — and the failure mode is mail going out under the
// wrong business's ABN, which nobody notices until a recipient asks who they are actually dealing
// with. A dedicated endpoint means changing it is an act, and an act leaves a trace.
//
// @machine-callable — called by Kira, not a browser. The middleware matcher excludes /api/*, and
// that exclusion is load-bearing: a session redirect here is a 307 the caller follows to an HTML
// page, so nothing throws, nothing logs, and the identity is simply never saved.

import { NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabase';
import {
  CONTRACT_VERSION,
  ORCHESTRATOR_AUTH_HEADER,
  type TenantIdentityRequest,
  type TenantIdentityResponse,
} from '@/src/contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 11 digits, however the caller spaced them. */
function normaliseAbn(raw: string): string | null {
  const digits = (raw || '').replace(/\D/g, '');
  return digits.length === 11 ? digits : null;
}

function reply(body: TenantIdentityResponse, status: number) {
  return NextResponse.json(body, { status });
}

export async function PUT(request: Request, context: { params: Promise<{ tenantId: string }> }) {
  const secret = process.env.ORCHESTRATOR_SECRET;
  if (!secret) {
    console.error('[tenant-identity] ORCHESTRATOR_SECRET unset — refusing rather than running unauthenticated.');
    return NextResponse.json({ error: 'Orchestrator not configured' }, { status: 503 });
  }
  if (request.headers.get(ORCHESTRATOR_AUTH_HEADER) !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { tenantId } = await context.params;
  if (!UUID.test(tenantId)) {
    return NextResponse.json({ error: 'tenantId must be a UUID' }, { status: 400 });
  }

  let body: TenantIdentityRequest;
  try {
    body = (await request.json()) as TenantIdentityRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (body.version && body.version !== CONTRACT_VERSION) {
    return NextResponse.json(
      { error: `unsupported contract version ${body.version}; this orchestrator speaks ${CONTRACT_VERSION}` },
      { status: 409 },
    );
  }

  // Validate BEFORE writing. A half-saved identity is the worst outcome available here: the connector
  // checks three columns, so a row with two of them filled still refuses to send, and it does so
  // looking configured. Either all three land or none do.
  const legalName = (body.legalName || '').trim();
  const postalAddress = (body.postalAddress || '').trim();
  const abn = normaliseAbn(body.abn || '');

  const missing: string[] = [];
  if (!legalName) missing.push('legalName');
  if (!abn) missing.push('abn (11 digits)');
  if (!postalAddress) missing.push('postalAddress');
  if (missing.length) {
    return reply(
      {
        version: CONTRACT_VERSION,
        tenantId,
        canSend: false,
        error: `cannot send without: ${missing.join(', ')}`,
      },
      400,
    );
  }

  const supabase = serviceClient();

  // Upsert, for the same reason dispatch does: this may be the first thing that ever mentions the
  // tenant. `name` is only set on INSERT — an owner who has since renamed their tenant should not
  // have it reverted by an identity save, so the trading name goes to its own column below.
  const { error } = await supabase
    .from('tenants')
    .upsert(
      {
        id: tenantId,
        name: (body.tradingName || legalName).slice(0, 200),
        legal_name: legalName,
        abn,
        postal_address: postalAddress,
        reply_email: (body.replyEmail || '').trim() || null,
        // The verified sending address for THIS tenant's domain. Omitted or blank leaves the tenant
        // on the portfolio default — deliberately, because DNS verification usually sits with the
        // client's registrar or IT provider and must not block them being onboarded. Setting it
        // before Resend has verified the domain makes every send fail, so it belongs here, in a
        // call made once by a human who checked, and not in a config that drifts.
        from_email: (body.fromEmail || '').trim() || null,
      },
      { onConflict: 'id' },
    );

  if (error) {
    console.error('[tenant-identity] write failed:', error);
    // Report the failure. The caller records "synced" off this response, and a caller that believes
    // it synced when it did not is how a tenant sits unable to send with a green tick beside it.
    return reply(
      { version: CONTRACT_VERSION, tenantId, canSend: false, error: 'Could not save the identity' },
      500,
    );
  }

  console.log(`[tenant-identity] ${tenantId}: identity set (${legalName}, ABN ${abn}) — sends now permitted.`);
  return reply({ version: CONTRACT_VERSION, tenantId, canSend: true }, 200);
}
