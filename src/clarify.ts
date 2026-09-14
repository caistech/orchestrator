// src/clarify.ts — T1: the clarify pass (DESIGN §5.1, /plan-eng-review D4).
//
// The gate's job is structural, not conversational: whatever adapter asks, this module makes sure
// the loop is BOUNDED. A dispatch holds itself in 'clarifying' until the caller supplies the
// outstanding fields, and a loop that never gets them dies — count or TTL, whichever bites first —
// so an unanswered clarification cannot sit as a live task forever pretending to await nothing.
//
// The trigger is CALLER-INITIATED in v1: Kira's agent hears the ambiguity in the room and asks; the
// orchestrator enforces the structure. Nothing here auto-enters a live SAY dispatch — an ordinary
// request (no `clarification` block) is evaluated, found to be a normal dispatch, and the gate
// returns `proceed` untouched. That is the regression guard: the owner's current speak→draft flow
// must not silently start interrogating him.
//
// This module is pure where it can be (the state machine, the prompt) and keeps every database
// write in the route/the housekeeping helper. That split is what makes the failure modes testable
// as the code paths they actually are, rather than through a mocked HTTP round trip.

import type {
  ClarifyField,
  DispatchClarification,
  DispatchRequest,
} from '@/src/contract';
import type { SupabaseClient } from '@supabase/supabase-js';

/** The gate cancels a clarifying task after this many rounds spent. D4's structural max. */
export const MAX_CLARIFY_ROUNDS = 2;
/** A clarifying task auto-cancels this long after it first asked. Unanswered beats vague (D4). */
export const CLARIFY_TTL_MS = 48 * 60 * 60 * 1000;

/** Context/payload keys the caller can already hold for each field, beyond the answers block. */
const CONTEXT_KEYS: Record<ClarifyField, string> = {
  objective: 'objective',
  responsibleTier: 'responsibleTier',
  successCriteria: 'successCriteria',
  dueAt: 'dueAt',
};

const ALL_FIELDS: readonly ClarifyField[] = ['objective', 'responsibleTier', 'successCriteria', 'dueAt'];

/**
 * Turns whatever a row's `clarify_missing` holds back into the field list the gate reasons about.
 * Stored jsonb could be anything; only the four known names are ever treated as fields. A list of
 * names typed as string proves nothing until it has been checked against the only four that exist.
 */
export function asClarifyFields(value: unknown): ClarifyField[] {
  if (!Array.isArray(value)) return [];
  return ALL_FIELDS.filter((field) => value.includes(field));
}

const FIELD_LABELS: Record<ClarifyField, string> = {
  objective: 'exactly what you need done',
  responsibleTier: 'who is meant to do it — you or one of your team',
  successCriteria: 'what \u2018done\u2019 looks like',
  dueAt: 'when it is due',
};

export interface ClarifySessionRow {
  id: string;
  status: string | null;
  clarify_count: number | null;
  clarify_ttl_at: string | null;
  clarify_missing: unknown;
  clarify_answers: unknown;
}

export type ClarifyOutcome =
  /** A round is owed (fresh ask, or the answers still left fields open). */
  | { mode: 'ask'; count: number; missing: ClarifyField[]; ttlAt: string }
  /** The dispatch is sufficiently specified — run the normal path. */
  | { mode: 'proceed' }
  /** The loop is dead: TTL or rounds exhausted, journaled on the row. */
  | { mode: 'cancelled'; reason: 'clarify_timeout' | 'clarify_exhausted'; detail: string };

function normalise(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function valueFor(field: ClarifyField, req: DispatchRequest): string | null {
  const answer = normalise(req.clarification?.answers?.[field]);
  if (answer) return answer;
  const context = req.context?.[CONTEXT_KEYS[field]];
  if (typeof context === 'string' && context.trim().length > 0) return context.trim();
  return null;
}

/** SAY carries its own objective and the route already tiers a spoken task — see `responsibleTier`. */
function clarifyFieldSatisfied(field: ClarifyField, req: DispatchRequest): boolean {
  if (valueFor(field, req)) return true;
  if (field === 'objective') return normalise(req.utterance) != null;
  if (field === 'responsibleTier') return req.ingress === 'SAY';
  return false;
}

/**
 * Which outstanding fields the dispatch still owes, scoped to the caller's own `required` list when
 * it gave one (asking for only two things must not be answered with four questions). An ordinary
 * dispatch with no `required` is assessed against all four — which matters only for the caller who
 * opts into a loop; the gate itself never auto-enters one.
 */
export function assessClarification(req: DispatchRequest): ClarifyField[] {
  const scope =
    req.clarification?.required && req.clarification.required.length > 0
      ? req.clarification.required
      : (['objective', 'responsibleTier', 'successCriteria', 'dueAt'] as const);
  // Canonical order always (objective → tier → criteria → due): the prompt reads naturally when the
  // due time walks last in one breath.
  return ALL_FIELDS.filter(
    (field) => (scope as readonly ClarifyField[]).includes(field) && !clarifyFieldSatisfied(field, req),
  );
}

function isExpired(ttlAt: string | null, now: Date): boolean {
  if (!ttlAt) return false;
  const deadline = new Date(ttlAt).getTime();
  return Number.isFinite(deadline) && deadline <= now.getTime();
}

/** An answer satisfies a field when it is a non-blank string. Nothing is ever derived from it. */
function answersSatisfy(answers: Partial<Record<ClarifyField, string>>, field: ClarifyField): boolean {
  return normalise(answers[field]) != null;
}

/**
 * The gate's heart. Everything a loop can become, decided from the request and the row alone.
 *
 * @param existing the stored task row — or null on the FIRST leg of a loop, when nothing has been
 *   persisted yet. Callers pass only the id/status/clarify_* columns it selects.
 */
export function evaluateClarifyGate(
  req: DispatchRequest,
  existing: ClarifySessionRow | null,
  now: Date,
): ClarifyOutcome {
  if (!req.clarification) return { mode: 'proceed' };

  if (!existing || existing.status !== 'clarifying') {
    // A dispatch carrying a clarify block but no live session. An ANSWERING dispatch has nothing to
    // answer yet — it simply carries extra specification and proceeds (the answers travel into the
    // task's journal). A REQUESTING dispatch opens the loop with the fields it still needs.
    if (req.clarification.answers) return { mode: 'proceed' };
    const missing = assessClarification(req);
    if (!req.clarification.required || req.clarification.required.length === 0 || missing.length === 0) {
      // Nothing owed, or nothing asked for — proceeding is the truthful answer either way.
      return { mode: 'proceed' };
    }
    return {
      mode: 'ask',
      count: 1,
      missing,
      ttlAt: new Date(now.getTime() + CLARIFY_TTL_MS).toISOString(),
    };
  }

  // A live session exists. The TTL wins over everything else — even this round's answers arrive,
  // a question that sat unanswered past its deadline is not resurrected by dinner.
  if (isExpired(existing.clarify_ttl_at, now)) {
    return {
      mode: 'cancelled',
      reason: 'clarify_timeout',
      detail: 'This clarification was left unanswered past its deadline and was cancelled.',
    };
  }

  const storedMissing = asClarifyFields(existing.clarify_missing);

  // No answers supplied: the caller is re-issuing the question (a retry after the owner went quiet,
  // or a poll). The current ask is idempotently re-served rather than advanced. An ANSWERING
  // dispatch is the only thing that advances the loop below.
  if (!req.clarification?.answers) {
    return { mode: 'ask', count: existing.clarify_count ?? 1, missing: storedMissing, ttlAt: existing.clarify_ttl_at ?? '' };
  }

  // Answers supplied, loop live. What still stands owed, against the CUMULATIVE set (a round may
  // answer some of the previous round's questions).
  const cumulative = {
    ...(existing.clarify_answers && typeof existing.clarify_answers === 'object'
      ? (existing.clarify_answers as Partial<Record<ClarifyField, string>>)
      : {}),
    ...(req.clarification.answers ?? {}),
  };
  const stillMissing = storedMissing.filter((field) => !answersSatisfy(cumulative, field));

  if (stillMissing.length === 0) return { mode: 'proceed' };

  const nextCount = (existing.clarify_count ?? 1) + 1;
  if (nextCount > MAX_CLARIFY_ROUNDS) {
    return {
      mode: 'cancelled',
      reason: 'clarify_exhausted',
      detail: 'This request went around the clarify loop too many times unanswered and was cancelled.',
    };
  }
  return { mode: 'ask', count: nextCount, missing: stillMissing, ttlAt: existing.clarify_ttl_at ?? '' };
}

/**
 * The question, phrased for a voice agent to read out. `required` is the field list from the ask
 * outcome; a human being asked "what does \u2018done\u2019 look like and when is it due" in one breath
 * answers faster than being interrogated.
 */
export function buildClarifyPrompt(required: ClarifyField[]): string {
  if (required.length === 0) return 'One last thing, then I can run with this.';
  const list = required.map((field) => FIELD_LABELS[field]).join(' and ');
  return `Before I run with this I need ${list}.`;
}

/** A plain language summary of a cancel reason, for the message a caller says out loud. */
export function clarifyCancelMessage(reason: 'clarify_timeout' | 'clarify_exhausted'): string {
  return reason === 'clarify_timeout'
    ? 'That request sat with a question unanswered for too long, so I cancelled it — just ask me again and I\u2019ll get it moving.'
    : 'That request went around the loop too many times, so I cancelled it — let\u2019s start again and I\u2019ll pin down the details first.';
}

/**
 * The TTL housekeeping pass (hourly cron). Every clarifying task whose deadline has passed is
 * flipped to `failed` with the journaled reason, so *reads* that reach the store see the truth
 * (up to the sweep's cadence) even if the owner never answered. The OTHER enforcement point is
 * interaction: a re-dispatch that arrives after TTL is cancelled in the gate itself, so a stale
 * ask can never be resurrected by dinner. Fail-soft: a blocked pass must not break the sweep.
 */
export async function cancelExpiredClarifyTasks(
  supabase: SupabaseClient,
  tenantId: string,
  now: Date = new Date(),
): Promise<number> {
  const nowIso = now.toISOString();
  const { data: expired, error } = await supabase
    .from('tasks')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('status', 'clarifying')
    .not('clarify_ttl_at', 'is', null)
    .lt('clarify_ttl_at', nowIso);
  if (error || !expired || expired.length === 0) return 0;

  const ids = expired.map((row: { id: string }) => row.id);
  const { error: updateError } = await supabase
    .from('tasks')
    .update({
      status: 'failed',
      result: { error: 'clarify_timeout', detail: 'Clarify TTL expired before the round was answered.' },
      updated_at: nowIso,
    })
    .in('id', ids);
  return updateError ? 0 : ids.length;
}