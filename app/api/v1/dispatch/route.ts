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
import { classifyIntent, draftForIntent, OWNED_KINDS, type OwnedKind } from '@/src/drafter';

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

  // FIRST CONTACT PROVISIONS THE TENANT.
  //
  // tasks.tenant_id references tenants(id), and the caller's key is its OWN canonical business+owner
  // id — a real one that has never been seen here. Without this the very first dispatch from a live
  // caller violated the foreign key and returned 500, which the caller correctly reported to the
  // owner as "I couldn't reach the system that does that". The harness never caught it because it
  // used the seeded tenant, which of course already existed: a fixture that exists is exactly the
  // condition a first-contact bug hides behind.
  //
  // Safe to auto-create: a tenant provisioned this way has NO sender identity, and the email
  // connector already refuses to send without legal_name + abn + postal_address. So this can bring a
  // business into existence for the purpose of holding its tasks, and still cannot mail anyone on
  // its behalf until a human fills that in.
  const { error: tenantError } = await supabase
    .from('tenants')
    .upsert(
      { id: tenantId, name: (body.context?.ownerName as string) ?? 'Unnamed business' },
      { onConflict: 'id', ignoreDuplicates: true },
    );
  if (tenantError) {
    console.error('[dispatch] could not ensure tenant:', tenantError);
    return NextResponse.json({ error: 'Could not accept the task' }, { status: 500 });
  }

  // A SPOKEN intent gets classified and drafted here, then HELD. Without this the owner said
  // something out loud, got "Accepted." and nothing ever happened — the row sat queued forever,
  // because nothing else in the orchestrator processes a SAY task. Kira's local stub always did
  // this; moving the work here without bringing it would have made the product worse while looking
  // more connected.
  let classified: Awaited<ReturnType<typeof classifyIntent>> = null;
  let drafted: Awaited<ReturnType<typeof draftForIntent>> = null;
  let kind: OwnedKind | 'unsupported' = 'unsupported';

  const apiKey = process.env.OPENAI_API_KEY;
  if (body.ingress === 'SAY' && body.utterance && apiKey) {
    classified = await classifyIntent(apiKey, body.utterance);
    kind = classified?.kind ?? 'unsupported';
    if (classified && (OWNED_KINDS as string[]).includes(kind)) {
      // The owner's name comes from the CALLER, not from here. Identity of a person belongs to Kira;
      // this system holds a tenant. Absent, the drafter is told to sign off with no name rather than
      // invent one.
      const ownerName = (body.context?.ownerName as string) ?? null;
      drafted = await draftForIntent(apiKey, kind as OwnedKind, body.utterance, classified, ownerName, body.context);
    }
  }

  const holding = !!drafted;

  // The drafter FAILED, as distinct from having nothing to do.
  //
  // askModel swallows every error and returns null — a 429, a timeout, a malformed completion all
  // look identical to "no draft". Until now the route treated that exactly like a background job
  // waiting its turn: the row went in as `queued` and the caller was told "Accepted." So Kira told
  // an owner his email had been drafted and dispatched while the task sat undrafted forever, which
  // is the one failure the human-in-the-loop design exists to prevent — being told a thing happened
  // when it did not is worse than being told it cannot happen at all.
  //
  // A spoken request the classifier RECOGNISED but the drafter could not produce is a failure, and
  // it is now recorded and reported as one.
  const draftFailed =
    body.ingress === 'SAY' && (OWNED_KINDS as string[]).includes(kind) && !drafted;

  const { data, error } = await supabase
    .from('tasks')
    .insert({
      tenant_id: tenantId,
      intent_id: body.intentId,
      ingress: body.ingress,
      flow: body.flow ?? null,
      tier: body.ingress === 'SAY' ? 'C' : null,
      // Held for the owner when we have something to show them; 'unsupported' when nothing here can
      // do it — CAPTURED, never silently dropped, because that row is the agent-builder's backlog.
      status: holding
        ? 'awaiting_approval'
        : draftFailed
          ? 'failed'
          : kind === 'unsupported' && body.ingress === 'SAY'
            ? 'unsupported'
            : 'queued',
      utterance: body.utterance ?? null,
      summary: drafted?.summary ?? classified?.reason_if_unsupported ?? body.utterance?.slice(0, 200) ?? null,
      payload: { ...(body.payload ?? {}), kind, classified: classified ?? undefined },
      // Give the operator surfaces something to show besides a bare status. "The drafter did not
      // return anything" is a sentence someone can act on; a `failed` with no reason is not.
      ...(draftFailed
        ? { result: { error: 'draft_failed', detail: 'The drafter returned nothing for a recognised request.' } }
        : {}),
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
    detail: { ingress: body.ingress, via: 'v1/dispatch', kind },
    correlation_id: body.correlationId ?? null,
  });

  if (drafted) {
    await supabase.from('drafts').insert({
      task_id: data.id,
      channel: kind === 'reminder' ? 'reminder' : 'email',
      subject: classified?.subject ?? drafted.summary,
      body: drafted.preview,
      recipients: classified?.recipient_email ? [classified.recipient_email] : [],
    });
    await supabase.from('approvals').insert({ task_id: data.id });
  }

  // A send needs a recipient the classifier cannot invent. Telling the caller lets Kira ASK
  // ("what's Dave's email?") instead of dead-ending at approval time.
  const isSend = kind === 'email' || kind === 'quote';
  const needsRecipient = isSend && !classified?.recipient_email;

  return NextResponse.json({
    version: CONTRACT_VERSION,
    taskGroupId: data.id,
    status: data.status,
    draft: drafted
      ? { kind, summary: drafted.summary, preview: drafted.preview, artifact: { ...classified } }
      : undefined,
    needsRecipient,
    message: drafted
      ? "Drafted — say the word and I'll send it."
      : draftFailed
        ? // Said plainly, because Kira reads this out. The owner must hear that NOTHING happened.
          "I couldn't get that drafted just now — nothing has been sent. I've kept it and we can try again."
        : kind === 'unsupported' && body.ingress === 'SAY'
          ? classified?.reason_if_unsupported ?? "I've noted it — that's not one I can do myself yet."
          : 'Accepted.',
  });
}
