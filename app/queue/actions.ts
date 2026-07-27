'use server';

// The operator's decision, applied through the SAME path the API uses.
//
// Deliberately not a second implementation: if the UI wrote its own approval logic it would drift
// from /v1/tasks/:id/approve, and the two would eventually disagree about what "approved" means —
// which is the kind of divergence that surfaces as an email that went out twice, or not at all.

import { revalidatePath } from 'next/cache';
import { serviceClient } from '@/lib/supabase';

export async function decide(formData: FormData): Promise<void> {
  const taskId = String(formData.get('taskId') ?? '');
  const approve = String(formData.get('approve') ?? 'false') === 'true';
  if (!taskId) return;

  const secret = process.env.ORCHESTRATOR_SECRET;
  const base = process.env.NEXT_PUBLIC_APP_URL;

  // Prefer the HTTP route so there is exactly one approval implementation. Fall back to the direct
  // write only when the base URL is not configured (local runs), and keep the two in step.
  if (secret && base) {
    await fetch(`${base}/api/v1/tasks/${taskId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-orchestrator-secret': secret },
      body: JSON.stringify({ version: '1', tenantId: '', approve, decidedBy: 'operator (queue)' }),
    });
    revalidatePath('/queue');
    return;
  }

  const supabase = serviceClient();
  const { data: task } = await supabase.from('tasks').select('status, intent_id, payload').eq('id', taskId).maybeSingle();
  if (!task || task.status !== 'awaiting_approval') return;

  await supabase
    .from('approvals')
    .update({ decision: approve ? 'approved' : 'rejected', decided_by: 'operator (queue)', decided_at: new Date().toISOString() })
    .eq('task_id', taskId)
    .is('decided_at', null);

  if (!approve) {
    await supabase.from('tasks').update({ status: 'failed', result: { discarded: true } }).eq('id', taskId);
    await supabase.from('task_events').insert({ task_id: taskId, event: 'rejected', detail: {} });
  } else {
    const { data: draft } = await supabase.from('drafts').select('subject, body, recipients').eq('task_id', taskId).maybeSingle();
    await supabase.from('effects').insert({
      task_id: taskId,
      kind: 'email.send',
      connector: 'resend',
      idempotency_key: `approved:${task.intent_id}`,
      request: {
        to: (draft?.recipients as string[] | null)?.[0] ?? null,
        subject: draft?.subject,
        body: draft?.body,
        commercial: (task.payload as { commercial?: boolean } | null)?.commercial === true,
      },
    });
    await supabase.from('tasks').update({ status: 'queued' }).eq('id', taskId);
    await supabase.from('task_events').insert({ task_id: taskId, event: 'approved', detail: { by: 'operator (queue)' } });
  }

  revalidatePath('/queue');
}
