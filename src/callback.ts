// Telling the caller what happened — the other half of the seam.
//
// Without this the orchestrator is write-only from Kira's point of view: an owner says "chase Dave",
// the sweep or the connector finishes hours later, and nothing ever travels back. Kira could only
// poll, and a voice agent that must poll cannot say "that's gone out" when it goes out.
//
// FAIL-SOFT BY DESIGN. A caller that is down, slow or misconfigured must not fail the WORK. The
// email has already been sent; losing the notification is regrettable, rolling back the send is not
// possible, and throwing here would leave the task looking failed when it succeeded. So every error
// is logged and swallowed, and the task's own state remains the source of truth a poll can recover.

import type { TaskEventCallback } from './contract';
import { CALLBACK_AUTH_HEADER, CONTRACT_VERSION } from './contract';

export interface CallbackTarget {
  url: string;
  secret: string;
}

export function callbackTargetFromEnv(): CallbackTarget | null {
  const url = process.env.CALLBACK_URL;
  const secret = process.env.CALLBACK_SECRET;
  return url && secret ? { url, secret } : null;
}

export async function notifyCaller(
  event: Omit<TaskEventCallback, 'version' | 'at'>,
  target = callbackTargetFromEnv(),
): Promise<{ delivered: boolean; reason?: string }> {
  if (!target) return { delivered: false, reason: 'no callback target configured' };

  const payload: TaskEventCallback = {
    ...event,
    version: CONTRACT_VERSION,
    at: new Date().toISOString(),
  };

  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CALLBACK_AUTH_HEADER]: target.secret },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[callback] ${target.url} → ${res.status}`);
      return { delivered: false, reason: `HTTP ${res.status}` };
    }
    return { delivered: true };
  } catch (e) {
    console.error('[callback] failed:', e);
    return { delivered: false, reason: String((e as Error)?.message ?? e) };
  }
}
