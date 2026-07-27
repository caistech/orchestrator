// POST /v1/tasks/:id/approve — the human's yes or no.
//
// The gate held the task; this is the only thing that releases it. Nothing in this system sends
// approved work automatically on the strength of a draft existing — approval is a separate,
// recorded act, because "who said this could go out?" is asked after something goes wrong, not
// before.
//
// @machine-callable — called by Kira's adapter and by the review queue, never by a browser session.

import { NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabase';
import { CONTRACT_VERSION, ORCHESTRATOR_AUTH_HEADER, type ApproveRequest } from '@/src/contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const secret = process.env.ORCHESTRATOR_SECRET;
  if (!secret) return NextResponse.json({ error: 'Orchestrator not configured' }, { status: 503 });
  if (request.headers.get(ORCHESTRATOR_AUTH_HEADER) !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;
  let body: ApproveRequest;
  try { body = (await request.json()) as ApproveRequest; }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const supabase = serviceClient();
  const { data: task } = await supabase
    .from('tasks').select('id, status, tenant_id, summary').eq('id', id).maybeSingle();
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  // Idempotent: a task already decided keeps its decision. Re-approving must not re-send.
  if (task.status !== 'awaiting_approval') {
    return NextResponse.json({ version: CONTRACT_VERSION, taskGroupId: id, status: task.status, message: 'Already decided.' });
  }

  const approve = body.approve === true;
  await supabase.from('approvals').update({
    decision: approve ? 'approved' : 'rejected',
    decided_by: body.decidedBy ?? 'operator',
    reason: body.reason ?? null,
    decided_at: new Date().toISOString(),
  }).eq('task_id', id).is('decided_at', null);

  if (!approve) {
    await supabase.from('tasks').update({ status: 'failed', result: { discarded: true } }).eq('id', id);
    await supabase.from('task_events').insert({ task_id: id, event: 'rejected', detail: { reason: body.reason ?? null } });
    return NextResponse.json({ version: CONTRACT_VERSION, taskGroupId: id, status: 'failed', message: 'Discarded — nothing sent.' });
  }

  // Approval does not send. It puts the message in the OUTBOX, and the drain sends it — so a send
  // is always recorded before it is attempted, and "did it actually go?" has an answer.
  const { data: draft } = await supabase
    .from('drafts').select('subject, body, recipients').eq('task_id', id).maybeSingle();
  const { data: taskRow } = await supabase.from('tasks').select('payload, intent_id').eq('id', id).maybeSingle();
  const to = (draft?.recipients as string[] | null)?.[0] ?? null;

  await supabase.from('effects').insert({
    task_id: id,
    kind: 'email.send',
    connector: 'resend',
    idempotency_key: `approved:${taskRow?.intent_id ?? id}`,
    request: {
      to, subject: draft?.subject, body: draft?.body,
      commercial: (taskRow?.payload as { commercial?: boolean } | null)?.commercial === true,
    },
  });
  await supabase.from('tasks').update({ status: 'queued' }).eq('id', id);
  await supabase.from('task_events').insert({ task_id: id, event: 'approved', detail: { by: body.decidedBy ?? 'operator' } });

  return NextResponse.json({ version: CONTRACT_VERSION, taskGroupId: id, status: 'queued', message: 'Approved — queued to send.' });
}
