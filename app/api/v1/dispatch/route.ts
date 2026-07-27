// POST /v1/dispatch — the seam.
//
// This is the endpoint Kira's OrchestratorAdapter calls, and it is deliberately the ONLY way work
// enters from outside. It implements src/contract.ts, which mirrors Kira's SwarmCoordinator
// interface, so plugging this in changes no call site in Kira — and swapping this orchestrator for
// Gareth's swarm is KIRA_SWARM_ADAPTER plus a base URL, because the seam is a wire format rather
// than shared types.
//
// AUTH IS FAIL-CLOSED. An unset ORCHESTRATOR_SECRET returns 503, never "allow". The alternative
// shape — `if (secret && header !== secret)` — silently evaporates when the variable is missing,
// which is precisely how Kira's cron routes were publicly callable for a period. These seams carry
// live business data and can spend money.
//
// @machine-callable — this route is called by another SYSTEM, not a browser. The middleware matcher
// must never capture it; a session redirect here is a 307 the caller follows to an HTML page, which
// throws nothing, logs nothing, and simply means the feature never runs.

import { NextResponse } from 'next/server';
import { serviceClient, SEED_TENANT } from '@/lib/supabase';
import { CONTRACT_VERSION, ORCHESTRATOR_AUTH_HEADER, type DispatchRequest } from '@/src/contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const secret = process.env.ORCHESTRATOR_SECRET;
  if (!secret) {
    console.error('[dispatch] ORCHESTRATOR_SECRET unset — refusing rather than running unauthenticated.');
    return NextResponse.json({ error: 'Orchestrator not configured' }, { status: 503 });
  }
  if (request.headers.get(ORCHESTRATOR_AUTH_HEADER) !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: DispatchRequest;
  try {
    body = (await request.json()) as DispatchRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.intentId) return NextResponse.json({ error: 'intentId is required' }, { status: 400 });
  if (!body.ingress) return NextResponse.json({ error: 'ingress is required' }, { status: 400 });

  // Version mismatch is reported, never guessed at. A caller on a contract we do not implement must
  // hear about it now rather than have its fields silently dropped.
  if (body.version && body.version !== CONTRACT_VERSION) {
    return NextResponse.json(
      { error: `unsupported contract version ${body.version}; this orchestrator speaks ${CONTRACT_VERSION}` },
      { status: 409 },
    );
  }

  const supabase = serviceClient();
  const tenantId = body.tenantId || SEED_TENANT;

  const { data, error } = await supabase
    .from('tasks')
    .insert({
      tenant_id: tenantId,
      intent_id: body.intentId,
      ingress: body.ingress,
      flow: body.flow ?? null,
      // Everything arriving through this door is unrouted until a classifier exists. Saying
      // 'queued' is honest; saying 'running' would not be.
      status: 'queued',
      utterance: body.utterance ?? null,
      summary: body.utterance?.slice(0, 200) ?? null,
      payload: body.payload ?? {},
    })
    .select('id, status')
    .single();

  // The idempotency key doing its job: the same trigger delivered twice is one task. Return the
  // EXISTING task rather than an error — a caller retrying a timeout must not be told it failed.
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      const { data: existing } = await supabase
        .from('tasks')
        .select('id, status')
        .eq('tenant_id', tenantId)
        .eq('intent_id', body.intentId)
        .maybeSingle();
      return NextResponse.json({
        version: CONTRACT_VERSION,
        taskGroupId: existing?.id,
        status: existing?.status,
        message: 'Already dispatched.',
      });
    }
    console.error('[dispatch] insert failed:', error);
    return NextResponse.json({ error: 'Could not accept the task' }, { status: 500 });
  }

  await supabase.from('task_events').insert({
    task_id: data.id,
    event: 'routed',
    detail: { ingress: body.ingress, via: 'v1/dispatch' },
    correlation_id: body.correlationId ?? null,
  });

  return NextResponse.json({
    version: CONTRACT_VERSION,
    taskGroupId: data.id,
    status: data.status,
    message: 'Accepted.',
  });
}
