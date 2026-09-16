// The agent worker — background execution shared by the CLI script and the cron route.
//
// Two claims worth asserting, because they are the safety boundary of an async loop:
//   1. In dry-run the worker DECIDES but mutates nothing.
//   2. A task referencing an unregistered agent id is journaled LOUDLY (failed), never left
//      pending-looking — a task routed to nothing must not read as "in progress".

import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { runAgentWorker } from './worker';
import type { AgentEntry } from './register';

const AGENT: AgentEntry = {
  id: 'quoting_agent',
  function: 'test agent',
  tools: [],
  model: 'gpt-4.1-mini',
  maxIterations: 1,
  maxCost: 0.05,
  flowsUnlocked: [],
};

function makeSupabase(tasks: unknown[]) {
  const eq = vi.fn().mockResolvedValue({ error: null, data: null });
  const update = vi.fn((_values: unknown) => ({ eq }));
  const insert = vi.fn().mockResolvedValue({ error: null, data: [{ id: 'ef-1' }] });
  const upsert = vi.fn().mockResolvedValue({ error: null, data: null });
  const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });

  const from = vi.fn((table: string) => {
    if (table === 'tasks') {
      // The worker pulls tasks with select().in().not().order().limit(); the ratchet queries with
      // select().not().lt(). Both chain to a RESOLVED promise — the terminal link returns the data,
      // and `await`ing the whole chain yields it.
      const pullResult = Promise.resolve({ data: tasks, error: null });
      const ratchetResult = Promise.resolve({ data: [], error: null });
      const limit = vi.fn(() => pullResult);
      const order = vi.fn().mockReturnValue({ limit });
      const pullNot = vi.fn().mockReturnValue({ order });
      const inFn = vi.fn().mockReturnValue({ not: pullNot });
      const lt = vi.fn(() => ratchetResult);
      const ratchetNot = vi.fn().mockReturnValue({ lt });
      const select = vi.fn().mockImplementation(() => ({
        in: inFn,
        not: ratchetNot,
      }));
      return { select, update };
    }
    if (table === 'evidence_staging') return { upsert };
    if (table === 'delegation_policy') return { select: vi.fn().mockReturnValue({ eq: maybeSingle }), upsert };
    return { select: vi.fn().mockResolvedValue({ data: [], error: null }), insert, update, upsert };
  });

  return {
    from,
    _update: update,
    _insert: insert,
    _upsert: upsert,
  } as unknown as SupabaseClient & {
    _update: ReturnType<typeof vi.fn>;
    _insert: ReturnType<typeof vi.fn>;
    _upsert: ReturnType<typeof vi.fn>;
  };
}

describe('runAgentWorker', () => {
  it('dry-run reports would_run and mutates nothing', async () => {
    const supabase = makeSupabase([
      { id: 't1', tenant_id: 'tenant-1', utterance: 'quote for driveway', payload: {}, agent_id: 'quoting_agent', status: 'queued' },
    ]);

    const report = await runAgentWorker({ supabase, apiKey: 'sk-test', apply: false });

    expect(report.processed).toBe(1);
    expect(report.runs[0].status).toBe('would_run');
    expect(supabase._update).not.toHaveBeenCalled();
    expect(supabase._insert).not.toHaveBeenCalled();
    expect(supabase._upsert).not.toHaveBeenCalled();
  });

  it('journals an unknown agent id as failed — loud, not pending-looking', async () => {
    const supabase = makeSupabase([
      { id: 't1', tenant_id: 'tenant-1', utterance: 'x', payload: {}, agent_id: 'ghost_agent', status: 'queued' },
    ]);

    const report = await runAgentWorker({ supabase, apiKey: 'sk-test', apply: true });

    expect(report.runs[0].status).toBe('unknown_agent');
    const { calls } = supabase._update.mock;
    expect(calls.length).toBe(1);
    expect(calls[0][0].status).toBe('failed');
    expect(calls[0][0].summary).toContain('ghost_agent');
  });

  it('runs a live agent task to completion in apply mode', async () => {
    const supabase = makeSupabase([
      { id: 't1', tenant_id: 'tenant-1', utterance: 'quote for driveway', payload: {}, agent_id: AGENT.id, status: 'queued' },
    ]);

    // Stub the runner's LLM call so a real network request never happens.
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ action: 'draft_email', summary: 's', preview: 'p', artifact: {} }) } }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }),
    }) as unknown as typeof fetch;

    try {
      const report = await runAgentWorker({ supabase, apiKey: 'sk-test', apply: true });
      expect(report.runs[0].status).toBe('completed');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});