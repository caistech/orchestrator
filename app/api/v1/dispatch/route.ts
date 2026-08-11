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
import { serviceClient } from '@/lib/supabase';
import { CONTRACT_VERSION, type DispatchRequest } from '@/src/contract';
import { authoriseCaller } from '@/src/caller-auth';
import { classifyIntent, draftForIntent, OWNED_KINDS, type OwnedKind } from '@/src/drafter';
import { resolveRecipientByName, type RecipientResolution } from '@/src/connectors/google-contacts';
import { currentQuoteFormat, formatAsInstructions } from '@/src/knowledge/quote-format';
import { findComparableWork, comparablesAsContext, type Comparable } from '@/src/knowledge/past-pricing';
import { findMaterialCost, materialCostAsContext, type MaterialCost } from '@/src/knowledge/material-cost';

/**
 * Look a spoken name up in the tenant's own contact books.
 *
 * FAIL-SOFT BY CONSTRUCTION. This runs inside a live voice call, and a contact lookup is the least
 * important thing happening in one: an unconfigured OAuth client, a revoked token or a People API
 * outage must leave the owner exactly where he was before this existed — asked for the address —
 * never staring at a failed dispatch. Every error becomes `unavailable`, which the caller says out
 * loud honestly rather than reporting as "no such contact".
 */
async function lookupRecipient(
  supabase: ReturnType<typeof serviceClient>,
  tenantId: string,
  name: string,
): Promise<RecipientResolution | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  try {
    return await resolveRecipientByName(supabase, tenantId, name, clientId, clientSecret);
  } catch (error) {
    console.error('[v1/dispatch] contact lookup failed (asking the owner instead):', error);
    return { status: 'unavailable', reason: 'the contact lookup did not answer' };
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: DispatchRequest;
  try {
    body = (await request.json()) as DispatchRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Authorise the CALLER and the tenant it claims, together. Reading the body first is required to
  // do that — the tenant is in it — and costs nothing, since an unauthorised caller is refused
  // before a single row is touched.
  const auth = authoriseCaller(request, body.tenantId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
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
  // No SEED_TENANT fallback. It used to default here, so a dispatch that arrived without a tenant
  // succeeded and landed a real business's task in a dev fixture — findable only by someone who
  // thought to look in the seed tenant. authoriseCaller has already rejected a blank tenantId with
  // a 400, which is what the contract says the list leg does and what this leg should always have.
  const tenantId = body.tenantId.trim();

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
  let contactLookup: RecipientResolution | null = null;
  /** Which learned quote format shaped this draft — null when the tenant has none. Recorded on the task. */
  let quoteFormatVersion: number | null = null;
  /** Prior priced work the drafter was shown. Recorded so a reviewer sees the same figures it saw. */
  let comparables: Comparable[] = [];
  /** Supplier COSTS the drafter was shown — a different question from what we charged, see below. */
  let materialCosts: MaterialCost[] = [];

  const apiKey = process.env.OPENAI_API_KEY;
  if (body.ingress === 'SAY' && body.utterance && apiKey) {
    classified = await classifyIntent(apiKey, body.utterance);
    kind = classified?.kind ?? 'unsupported';

    // The owner said a NAME, not an address — "send an RFQ to Roger at Quantum Surveys". The
    // classifier is forbidden from inventing the address, correctly, so this is where the task used
    // to stop: an RFQ for Lot 109 sat queued for three days with `to: null` because nothing could
    // turn "Roger" into an email. His contact book can.
    //
    // A single match is a SUGGESTION, and the read-back before sending is unchanged — a lookup can
    // return the wrong Roger as easily as a transcription can drop a letter. Several matches, or
    // none, leave the address null and the existing "ask him" path handles it exactly as before.
    if (classified?.recipient_name && !classified.recipient_email) {
      contactLookup = await lookupRecipient(supabase, body.tenantId, classified.recipient_name);
      if (contactLookup?.status === 'resolved') {
        classified = { ...classified, recipient_email: contactLookup.match.email };
      }
    }

    if (classified && (OWNED_KINDS as string[]).includes(kind)) {
      // The owner's name comes from the CALLER, not from here. Identity of a person belongs to Kira;
      // this system holds a tenant. Absent, the drafter is told to sign off with no name rather than
      // invent one.
      const ownerName = (body.context?.ownerName as string) ?? null;

      // FLOW 16 — build the quote in THIS business's format.
      //
      // A cheap indexed read of a standing fact, not an agent dispatched to go and look: the format
      // was extracted from their own past quotes once and versioned (`src/knowledge/quote-format.ts`).
      // Re-deriving it per quote would cost a Drive round trip plus an extraction call every time,
      // and would let the same business get a different format on Tuesday than it got on Monday.
      //
      // Only for `quote`. An email or a reminder has no format to honour, and loading one would be a
      // query per dispatch for nothing.
      let formatInstructions: string | null = null;
      if (kind === 'quote') {
        const stored = await currentQuoteFormat(supabase, tenantId);
        // Absent is a real state — no Google connection, or their quotes are PDFs. The drafter falls
        // back to its business-agnostic quote: worse output, honest output. Recorded on the task so
        // "why does this look generic?" has an answer that is not a guess.
        if (stored) formatInstructions = formatAsInstructions(stored);
        quoteFormatVersion = stored?.version ?? null;

        // FLOW 13 — what did we charge last time? The format gives the quote its shape; this gives
        // it its numbers. One indexed read of rows a connector already put in the entity index, so
        // no model and no second source of truth for a figure the accounting system owns.
        comparables = await findComparableWork(supabase, tenantId, {
          client: classified.recipient_name,
          description: body.utterance,
        });

        // FLOW 14a — what did the MATERIALS cost? A different question from flow 13, and the two
        // must never be conflated: one is what we charged a client, the other is what we paid a
        // supplier. Quoting at cost is the expensive way to confuse them, so each block carries its
        // own refusal rather than sharing one.
        materialCosts = await findMaterialCost(supabase, tenantId, body.utterance);
      }

      const priorWork = comparablesAsContext(comparables);
      const supplierCosts = materialCostAsContext(materialCosts);
      drafted = await draftForIntent(
        apiKey,
        kind as OwnedKind,
        body.utterance,
        classified,
        ownerName,
        // Comparables travel in `context`, which the drafter already prints verbatim into the
        // prompt. The refusal instruction travels WITH them rather than living in the drafter's
        // system prompt, so a caller can never get the figures without the warning attached.
        priorWork || supplierCosts
          ? {
              ...(body.context ?? {}),
              ...(priorWork ? { priorWork } : {}),
              ...(supplierCosts ? { supplierCosts } : {}),
            }
          : body.context,
        formatInstructions,
      );
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
      payload: {
        ...(body.payload ?? {}),
        kind,
        classified: classified ?? undefined,
        // Recorded for QUOTES ONLY, and recorded even when null. "This quote used their format v3"
        // and "this quote is generic because they have no format yet" are both answers a reviewer
        // needs, and reconstructing which one applied after the fact is impossible.
        ...(kind === 'quote'
          ? {
              quoteFormatVersion,
              // The figures the drafter saw, recorded on the task. If a price ends up in a quote
              // that nobody dictated, this is the list to check it against.
              comparables: comparables.map((c) => ({ label: c.label, amount: c.amount, when: c.when })),
              materialCosts: materialCosts.map((m) => ({ description: m.description, unitAmount: m.unitAmount, when: m.when })),
            }
          : {}),
      },
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

  // What to SAY about the lookup, appended to the message Kira reads out.
  //
  // Three outcomes, three different sentences, and the third is the one worth being careful about:
  // "I don't have a Roger" and "I can't see your contacts" send the owner off to do completely
  // different things, so a failed lookup must never be reported as an empty one.
  const lookupLine =
    contactLookup?.status === 'ambiguous'
      ? ` I found more than one ${classified?.recipient_name ?? 'match'} — ${contactLookup.matches
          .map((m) => `${m.name ?? 'unnamed'} at ${m.email}`)
          .join(', ')}. Which one?`
      : contactLookup?.status === 'unavailable'
        ? ` I couldn't check your contacts (${contactLookup.reason}), so I'll need the address.`
        : '';

  return NextResponse.json({
    version: CONTRACT_VERSION,
    taskGroupId: data.id,
    status: data.status,
    draft: drafted
      ? { kind, summary: drafted.summary, preview: drafted.preview, artifact: { ...classified } }
      : undefined,
    needsRecipient,
    // Stated so the caller can say where an address came from. An address the owner never spoke,
    // read back without saying it was looked up, invites a yes to a question he did not know he was
    // being asked.
    recipientSource: contactLookup?.status === 'resolved' ? 'contacts' : undefined,
    recipientOptions:
      contactLookup?.status === 'ambiguous'
        ? contactLookup.matches.map((m) => ({ name: m.name, email: m.email }))
        : undefined,
    message: drafted
      ? `Drafted — say the word and I'll send it.${lookupLine}`
      : draftFailed
        ? // Said plainly, because Kira reads this out. The owner must hear that NOTHING happened.
          "I couldn't get that drafted just now — nothing has been sent. I've kept it and we can try again."
        : kind === 'unsupported' && body.ingress === 'SAY'
          ? classified?.reason_if_unsupported ?? "I've noted it — that's not one I can do myself yet."
          : 'Accepted.',
  });
}
