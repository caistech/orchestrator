// The agent runner — executes the read→plan→emit loop.
//
// The two structural claims this must hold:
//   1. The agent NEVER holds an effect tool — it emits an effect row to the outbox, and the
//      drain performs it after the gate cleared.
//   2. Caps are hard stops ($, iterations), and a cap breach fails the task LOUDLY rather than
//      quietly succeeding with a partial effect.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { runAgentTask } from './runner';
import type { AgentEntry } from './register';

const AGENT: AgentEntry = {
  id: 'quoting_agent',
  function: 'Drafts complex quotes from historical pricing and material costs.',
  tools: ['quote_format.read'],
  model: 'gpt-4.1-mini',
  maxIterations: 1,
  maxCost: 0.05,
  flowsUnlocked: ['16', '20', '33'],
};

const BASE_TASK = {
  id: 'task-1',
  tenant_id: 'tenant-1',
  utterance: 'quote for a driveway repave for Roger',
  payload: { recipient_name: 'Roger' },
};

function makeSupabase() {
  const inserts: Record<string, ReturnType<typeof vi.fn>> = {};
  const insertFor = (table: string) => {
    if (!inserts[table]) inserts[table] = vi.fn().mockResolvedValue({ error: null, data: [{ id: 'ef-1' }] });
    return inserts[table];
  };
  const eq = vi.fn().mockResolvedValue({ error: null, data: null });
  const update = vi.fn((_values: unknown) => ({ eq }));
  const from = vi.fn((table: string) => ({ insert: insertFor(table), update }));
  return {
    from,
    _insertEffects: insertFor('effects'),
    _insertEvents: insertFor('task_events'),
    _update: update,
  } as unknown as SupabaseClient & {
    _insertEffects: ReturnType<typeof vi.fn>;
    _insertEvents: ReturnType<typeof vi.fn>;
    _update: ReturnType<typeof vi.fn>;
  };
}

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  mockFetch.mockReset();
  vi.unstubAllGlobals();
});

describe('runAgentTask', () => {
  it('emits an effect to the outbox and holds for approval, never sends directly', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          action: 'draft_email',
          summary: 'Draft quote email to Roger',
          preview: 'Hi Roger, your quote is attached...',
          artifact: { to: 'roger@example.com', subject: 'Quote — driveway repave' },
        }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    });

    const supabase = makeSupabase();
    const result = await runAgentTask({ supabase, task: BASE_TASK, agent: AGENT, apiKey: 'sk-test' });

    expect(result.status).toBe('completed');
    expect(result.effect).not.toBeNull();
    expect(result.effect!.kind).toBe('email.draft');

    // The agent wrote the effect row to the OUTBOX, not to a connector.
    expect(supabase._insertEffects).toHaveBeenCalledTimes(1);
    expect(typeof (supabase._insertEffects.mock.calls[0][0] as { idempotency_key: string }).idempotency_key).toBe('string');
    // And it journaled the completion.
    expect(supabase._insertEvents).toHaveBeenCalledTimes(1);

    // The task holds for a human.
    expect(supabase._update).toHaveBeenCalled();
    const updateArg = supabase._update.mock.calls[0][0] as { status: string };
    expect(updateArg.status).toBe('awaiting_approval');
  });

  it('fails loudly when the model call fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    const supabase = makeSupabase();
    const result = await runAgentTask({ supabase, task: BASE_TASK, agent: AGENT, apiKey: 'sk-test' });

    expect(result.status).toBe('failed');
    expect(result.effect).toBeNull();
    expect(result.reason).toContain('500');
  });

  it('fails loudly when the model returns an unrecognised action', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ action: 'fly_to_moon', summary: '', preview: '' }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });

    const supabase = makeSupabase();
    const result = await runAgentTask({ supabase, task: BASE_TASK, agent: AGENT, apiKey: 'sk-test' });

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('unrecognised plan action');
    expect(supabase._insertEffects).not.toHaveBeenCalled();
  });

  it('enforces the cost cap — a breached cap fails the task loudly', async () => {
    // 1M output tokens ≈ $600+, far over the 5¢ cap.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ action: 'draft_email', summary: 's', preview: 'p' }) } }],
        usage: { prompt_tokens: 10_000, completion_tokens: 1_000_000 },
      }),
    });

    const supabase = makeSupabase();
    const result = await runAgentTask({ supabase, task: BASE_TASK, agent: AGENT, apiKey: 'sk-test' });

    expect(result.status).toBe('cap_exceeded');
    expect(result.reason).toContain('maxCost');
    expect(supabase._insertEffects).not.toHaveBeenCalled();
  });

  it('enforces the iteration cap — an agent configured for one pass runs once', async () => {
    // Even if the model wanted to iterate, a maxIterations:1 agent gets exactly one plan call.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ action: 'draft_email', summary: 's', preview: 'p' }) } }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }),
    });

    const supabase = makeSupabase();
    const result = await runAgentTask({ supabase, task: BASE_TASK, agent: AGENT, apiKey: 'sk-test' });
    expect(result.iterations).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});