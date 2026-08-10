// GET /v1/tasks?tenantId=…&status=…&limit=… — the LIST leg of the contract.
//
// WHY THIS EXISTS. The poll leg (/v1/tasks/:id) can only ask about a task the caller already knows
// about. Kira mirrors a task into its own database at dispatch, inside a live voice call, and when
// that write is lost the task exists HERE and on no screen THERE — permanently, because every repair
// path on Kira's side begins by selecting the rows it already has. Measured on 31 July: four tasks
// awaiting the owner's approval here, one of them mirrored. His dashboard said one.
//
// This is the only endpoint that can answer "what do you hold for this tenant that I don't?".
//
// TENANT IS REQUIRED, AND THAT IS THE SECURITY POSTURE. A missing filter on a by-id read exposes one
// task to a caller already holding the shared secret; a missing filter on a LIST hands over every
// business's task summaries in one request. So a blank or absent tenantId is a 400 — never an
// implicit "all". The same reasoning as the Drive connect route: the widening case must be the one
// that fails, not the one that defaults.
//
// @machine-callable

import { NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabase';
import { CONTRACT_VERSION, type TaskListItem, type TaskState } from '@/src/contract';
import { authoriseCaller } from '@/src/caller-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TASK_STATES: readonly TaskState[] = [
  'queued',
  'awaiting_approval',
  'scheduled',
  'done',
  'failed',
  'unsupported',
];

/** Bounded so one tenant with a long history cannot time the request out and repair nothing. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * The classifier's own verdict, not a guess.
 *
 * `payload.kind` is written when the drafter classifies, and the caller's table requires a kind that
 * is NOT NULL. Returning null when we genuinely do not know is the honest half: it lets the caller
 * decide, rather than having this end invent 'email' for a reminder because a column needed filling.
 */
function kindOf(payload: unknown): string | null {
  const kind = (payload as { kind?: unknown } | null)?.kind;
  return kind === 'quote' || kind === 'email' || kind === 'reminder' ? kind : null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tenantId = (url.searchParams.get('tenantId') ?? '').trim();

  // authoriseCaller enforces both halves: tenantId present (400 if not — the rule this route's own
  // header comment states) and this caller permitted to act for it (403 if not).
  const auth = authoriseCaller(request, tenantId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // An unrecognised status is rejected rather than ignored: silently dropping the filter would widen
  // the answer, and a caller asking for the three open states would quietly receive every task it
  // has ever raised and treat the terminal ones as outstanding.
  const requested = (url.searchParams.get('status') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = requested.filter((s) => !TASK_STATES.includes(s as TaskState));
  if (unknown.length) {
    return NextResponse.json({ error: `Unknown status: ${unknown.join(', ')}` }, { status: 400 });
  }

  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  let query = serviceClient()
    .from('tasks')
    .select('id, status, summary, utterance, payload, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (requested.length) query = query.in('status', requested);

  const { data, error } = await query;
  if (error) {
    console.error('[v1/tasks] list failed:', error);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  const rows = data ?? [];
  const tasks: TaskListItem[] = rows.map((t) => ({
    taskGroupId: t.id as string,
    status: t.status as TaskState,
    kind: kindOf(t.payload),
    utterance: (t.utterance as string | null) ?? null,
    summary: (t.summary as string | null) ?? null,
    createdAt: t.created_at as string,
  }));

  return NextResponse.json({
    version: CONTRACT_VERSION,
    tenantId,
    tasks,
    // Said out loud rather than inferred from a length: a caller that reads a full page as "that's
    // everything" stops repairing exactly when there is most left to repair.
    truncated: rows.length === limit,
  });
}
