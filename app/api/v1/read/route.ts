// POST /v1/read — answer a question from a connected system, without changing anything.
//
// The counterpart to /v1/dispatch. Dispatch is for DOING, and everything it produces is held for a
// human. This is for KNOWING, and it holds nothing, because a read cannot be regretted the way a
// send can. That asymmetry is why read access can be generous where write access is not.
//
// AUTH IS FAIL-CLOSED, same as dispatch: an unset ORCHESTRATOR_SECRET is a 503, never an allow.
//
// The resource whitelist lives in the connector, not here. A route that accepts a path or a query
// from its caller is a proxy for whatever the caller can imagine — including Xero's payroll and
// employee endpoints, which nobody asked to expose. The caller names a resource; we own the query.

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { ORCHESTRATOR_AUTH_HEADER } from '@/src/contract';
import { readXero, XERO_RESOURCES, XeroNotConnected, XeroUnsupportedResource } from '@/src/connectors/xero-read';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const secret = process.env.ORCHESTRATOR_SECRET;
  if (!secret) {
    console.error('[read] ORCHESTRATOR_SECRET unset — refusing rather than running unauthenticated.');
    return NextResponse.json({ error: 'Orchestrator not configured' }, { status: 503 });
  }
  if (request.headers.get(ORCHESTRATOR_AUTH_HEADER) !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { tenantId?: string; provider?: string; resource?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const tenantId = body.tenantId;
  const provider = (body.provider ?? 'xero').toLowerCase();
  const resource = body.resource ?? '';
  if (!tenantId) return NextResponse.json({ error: 'tenantId is required' }, { status: 400 });
  if (provider !== 'xero') {
    return NextResponse.json({ error: `No reader for provider "${provider}"`, available: ['xero'] }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  try {
    const result = await readXero(supabase, tenantId, resource);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    // Each failure is DIFFERENT out loud, and the distinction matters more here than the status
    // code does. "You have not connected Xero" is something the owner can fix in a minute; "I can't
    // look that up" is not; and neither may ever be flattened into a zero, which would be heard as
    // "nothing is owing" — a false answer about money, from a tool bought to be trusted about money.
    if (error instanceof XeroNotConnected) {
      return NextResponse.json(
        { ok: false, reason: 'not_connected', message: 'This business has not connected Xero yet.' },
        { status: 200 },
      );
    }
    if (error instanceof XeroUnsupportedResource) {
      return NextResponse.json(
        { ok: false, reason: 'unsupported_resource', message: error.message, available: XERO_RESOURCES },
        { status: 200 },
      );
    }
    console.error('[read] xero read failed:', error);
    return NextResponse.json(
      { ok: false, reason: 'upstream_error', message: 'Could not reach Xero just now.' },
      { status: 200 },
    );
  }
}
