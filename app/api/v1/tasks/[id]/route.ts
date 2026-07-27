// GET /v1/tasks/:id — the poll leg of the contract.
//
// The callback is the primary return path; this exists for the case a caller cannot receive one, or
// has lost track and wants to ask. Kira's adapter uses it for getTaskState.
//
// @machine-callable.

import { NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabase';
import { CONTRACT_VERSION, ORCHESTRATOR_AUTH_HEADER } from '@/src/contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const secret = process.env.ORCHESTRATOR_SECRET;
  if (!secret) return NextResponse.json({ error: 'Orchestrator not configured' }, { status: 503 });
  if (request.headers.get(ORCHESTRATOR_AUTH_HEADER) !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;
  const { data: task } = await serviceClient()
    .from('tasks')
    .select('id, status, summary, drafts(subject, body, recipients)')
    .eq('id', id)
    .maybeSingle();

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
