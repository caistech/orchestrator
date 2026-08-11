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
import { CONTRACT_VERSION, type ApproveRequest } from '@/src/contract';
import { authoriseCaller } from '@/src/caller-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: ApproveRequest;
  try { body = (await request.json()) as ApproveRequest; }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  // This route was selecting the task by id with no tenant filter, so any caller holding the shared
  // secret could approve another business's drafted task. Approval is the step that EXECUTES —
  // it puts the mail on the wire under that tenant's name and ABN — which makes an unscoped approve
  // materially worse than an unscoped read.
  const auth = authoriseCaller(request, body.tenantId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const supabase = serviceClient();
  const { data: task } = await supabase
    .from('tasks').select('id, status, tenant_id, summary')
    .eq('id', id)
    .eq('tenant_id', body.tenantId.trim())
    .maybeSingle();
  // 404, not 403 — see the note in the sibling GET route.
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

  // WHERE IT GOES IS THE OWNER'S DECISION, RECORDED AT DRAFT TIME — not re-guessed here.
  //
  // "Just put it in drafts in Gmail" was asked three times in one call on 2026-08-11 and answered
  // "I'll save the draft in your Gmail", which nothing could do. `email.draft` writes it into HIS
  // mailbox so he sends it himself: from his real address, in his sent items, threading with the
  // client's earlier mail. `email.send` goes out through Resend from a noreply address we own.
  //
  // Defaulting to `send` on a missing value is deliberate and is the safe direction here ONLY because
  // this branch is already behind an explicit approval — the owner has said yes to something going
  // out. A payload that lost its delivery preference should behave as it did before this existed.
  const delivery = (taskRow?.payload as { delivery?: string } | null)?.delivery === 'draft' ? 'draft' : 'send';

  await supabase.from('effects').insert({
    task_id: id,
    kind: delivery === 'draft' ? 'email.draft' : 'email.send',
    connector: delivery === 'draft' ? 'google' : 'resend',
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
