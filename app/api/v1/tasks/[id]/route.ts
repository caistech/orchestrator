// GET /v1/tasks/:id — the poll leg of the contract.
//
// The callback is the primary return path; this exists for the case a caller cannot receive one, or
// has lost track and wants to ask. Kira's adapter uses it for getTaskState.
//
// @machine-callable.

import { NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabase';
import { CONTRACT_VERSION } from '@/src/contract';
import { authoriseCaller } from '@/src/caller-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  // tenantId is REQUIRED here, and it was not being asked for at all: this route selected a task by
  // id with no tenant filter, so any caller holding the secret could read any business's task — its
  // summary, and the full drafted email body with recipients — by guessing or reusing an id. The
  // contract's getTaskState always passes a tenantId; the route simply ignored it. The list leg's
  // own comment names this exact risk ("a missing filter on a by-id read leaks one task").
  const tenantId = (new URL(request.url).searchParams.get('tenantId') ?? '').trim();

  const auth = authoriseCaller(request, tenantId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { id } = await ctx.params;
  const { data: task } = await serviceClient()
    .from('tasks')
    .select('id, status, summary, drafts(subject, body, recipients)')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  // 404 rather than 403 when the task belongs to someone else: distinguishing "not yours" from
  // "does not exist" would confirm the id is real to a caller who should not know that.
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  const draft = (task as unknown as { drafts?: { subject: string; body: string; recipients: string[] }[] }).drafts?.[0];
  return NextResponse.json({
    version: CONTRACT_VERSION,
    taskGroupId: task.id,
    status: task.status,
    message: task.summary,
    draft: draft
      ? { kind: 'email', summary: task.summary ?? '', preview: draft.body, artifact: { recipients: draft.recipients } }
      : undefined,
  });
}
