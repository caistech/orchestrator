// Run the async agent workers — the background half of the doing-layer.
//
//   npm run agents                    process all agent-dispatched tasks, then exit
//   npm run agents -- --dry-run       decide, mutate nothing
//
// AGENTIC_NETWORK.md §3: "The loop runs ASYNC... Everything that iterates runs in the
// background; status via /v1/tasks; callback notifies."
//
// This is what actually executes the agentic network. It:
//   1. Pulls tasks in 'queued' or 'running' that carry an agent_id (the dispatch route marks
//      these when it routes to an async agent).
//   2. Runs the agent's plan→read→emit loop (src/agents/runner.ts).
//   3. When the effect clears (awaiting_approval or done), collects Genome evidence into
//      staging (src/genome/evidence-collector.ts).
//   4. After the outcome window closes, evaluates the trust ratchet for the (tenant, action)
//      pair and writes any promotion/demotion to the tenant's delegation_policy.
//
// It is deliberately a script, not a cron endpoint — same choice as the sweeper and drain:
// the scheduler that calls it is an operator concern (cron, GitHub Actions, a supervisor),
// and the script itself does one thing.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

import { agentFor } from '../src/agents/register';
import { runAgentTask } from '../src/agents/runner';
import { collectEvidence, persistStaging } from '../src/genome/evidence-collector';
import { evaluateRatchet, applyRatchetToPolicy } from '../src/agents/ratchet';
import type { Band } from '../src/gate';

const fileEnv = (() => {
  try {
    return Object.fromEntries(
      readFileSync('.env.local', 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
        }),
    );
  } catch {
    return {};
  }
})();

const e = { ...fileEnv, ...process.env } as Record<string, string>;
const dryRun = process.argv.includes('--dry-run');

if (!e.NEXT_PUBLIC_SUPABASE_URL || !e.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Supabase env missing.');
  process.exit(1);
}
// No OpenAI key check here — the runner uses it per-task, and many agent runs are
// deterministic (read-tool-only). The runner fails loudly per-task when the key is absent.

const supabase = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// The outcome window: how long after completion before a task counts as "clean".
// After this window closes with no complaint/rework registered, the ratchet may promote.
const OUTCOME_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const RATCHET_PROMOTION_THRESHOLD = 5;

async function main() {
  // ── Step 1: pull agent-dispatched tasks ────────────────────────────────────
  // 'running' covers the retried incarnation; a task stuck in running for too long is
  // picked up by the sweeper's housekeeping (SLA checks) before it reaches us.
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('id, tenant_id, utterance, payload, agent_id, status')
    .in('status', ['queued', 'running'])
    .not('agent_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(50);

  if (error) {
    console.error('could not read agent tasks:', error.message);
    process.exit(1);
  }

  console.log(`[agents] ${tasks.length} task(s) to process`);

  for (const task of tasks ?? []) {
    const agent = agentFor(task.agent_id);
    if (!agent) {
      // An unregistered agent id on a task is the loud failure mode — a task routed to
      // nothing. Journal it and move on; the task stays pending for a human.
      console.error(`[agents] task ${task.id} references unknown agent "${task.agent_id}"`);
      await supabase.from('tasks').update({ status: 'failed', summary: `unknown agent ${task.agent_id}` })
        .eq('id', task.id);
      continue;
    }

    if (dryRun) {
      console.log(`  [dry-run] would run "${agent.id}" on task ${task.id}`);
      continue;
    }

    try {
      const result = await runAgentTask({
        supabase,
        task: {
          id: task.id,
          tenant_id: task.tenant_id,
          utterance: task.utterance,
          payload: task.payload,
        },
        agent,
        apiKey: e.OPENAI_API_KEY ?? '',
      });

      console.log(
        `  ${result.status} ${agent.id} on ${result.taskId} (${result.iterations} iter, $${result.totalCost.toFixed(4)}${result.effect ? ', effect ' + result.effect.kind : ''})`,
      );

      if (result.status === 'completed' && result.effect) {
        // ── Step 2: feed Genome evidence into staging ─────────────────────────
        // Completed effects are evidence, but they land in staging — a human promotes
        // them into the Genome (AGENTIC_NETWORK.md §1.4).
        const effectRef = {
          id: task.id, // effect row equals task-hash; the drain uses task_id as the effect key
          task_id: task.id,
          kind: result.effect.kind,
          request: result.effect.request,
        };
        const staging = collectEvidence(effectRef, { tenant_id: task.tenant_id, payload: task.payload });
        if (staging.length > 0) {
          const { inserted, errors: stageErrors } = await persistStaging(supabase, staging);
          console.log(`  [evidence] ${inserted} staged, ${stageErrors} errors`);
        }
        // Mark the outcome window so the ratchet can later count this task.
        await supabase.from('tasks').update({
          ratchet_band: 'approve_before_send',
          ratchet_outcome_at: new Date(Date.now() + OUTCOME_WINDOW_MS).toISOString(),
        }).eq('id', task.id);
      }

      if (result.status === 'failed' || result.status === 'cap_exceeded') {
        // Fail the task and journal it — the owner must hear about a task that cannot
        // be done, never be told nothing.
        await supabase.from('tasks').update({
          status: 'failed',
          result: { agent_id: agent.id, error: result.reason, iterations: result.iterations, totalCost: result.totalCost },
        }).eq('id', task.id);
      }
    } catch (runError) {
      console.error(`  [agents] task ${task.id} run threw:`, runError);
      await supabase.from('tasks').update({
        status: 'failed',
        result: { agent_id: agent.id, error: String(runError) },
      }).eq('id', task.id);
    }
  }

  // ── Step 3: run the trust ratchet over closed outcome windows ──────────────
  // A task whose outcome window has closed receives its outcome. If enough of them are
  // clean, the ratchet promotes the delegation band for that action; a single dirty one
  // strips it. This is the "business detaches from the owner" mechanism: over time,
  // what the system can do without approval grows — on evidence, not on vibes.
  if (!dryRun) {
    await runRatchet();
  }

  console.log('[agents] done');
}

async function runRatchet() {
  const closed = await supabase
    .from('tasks')
    .select('id, tenant_id, status, ratchet_band, ratchet_outcome_clean, flow, agent_id')
    .not('ratchet_outcome_at', 'is', null)
    .lt('ratchet_outcome_at', new Date().toISOString());

  if (closed.error) {
    console.error('[ratchet] could not read closed outcomes:', closed.error.message);
    return;
  }

  console.log(`[ratchet] ${closed.data.length} closed outcome(s)`);

  // Mark all closed outcome windows as counted, regardless — the ratchet is a running
  // computation, not a one-shot. (This write is guarded; see tasks_ratchet_uncounted_idx.)
  for (const task of closed.data) {
    await supabase.from('tasks').update({
      ratchet_outcome_clean: task.ratchet_outcome_clean ?? (task.status === 'done' ? true : false),
    }).eq('id', task.id);
  }

  // Group by (tenant, action) and evaluate.
  const groups = new Map<string, typeof closed.data>();
  for (const task of closed.data) {
    const action = task.flow ?? task.agent_id ?? 'unknown';
    const key = `${task.tenant_id}:${action}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(task);
  }

  for (const [key, tasks] of groups) {
    const [tenantId] = key.split(':');
    const action = key.split(':').slice(1).join(':');

    // Load the tenant's delegation policy (or default to strict — silence means ask).
    const { data: policyRows } = await supabase
      .from('delegation_policy')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    const currentBand = policyRows?.band ?? 'approve_before_send';

    const outcomes = tasks.map((t) => ({
      taskId: t.id,
      tenantId,
      action,
      completedAt: new Date().toISOString(), // window closed now
      success: t.ratchet_outcome_clean ?? true,
      resolvedBand: currentBand as Band,
      ...(t.agent_id ? { agent: t.agent_id } : {}),
    }));

    if (outcomes.length === 0) continue;

    const decision = evaluateRatchet(
      policyRows ?? { bands: {}, reserved: [] },
      outcomes,
      { currentBand: currentBand as Band, promotionThreshold: RATCHET_PROMOTION_THRESHOLD },
    );

    console.log(`[ratchet] ${key}: ${decision.currentBand} → ${decision.effectiveBand} (${decision.reason})`);

    const updated = applyRatchetToPolicy(policyRows ?? { bands: {}, reserved: [] }, decision);
    if (updated) {
      // Write the promoted/demoted band back to the tenant's policy.
      await supabase.from('delegation_policy').upsert({
        tenant_id: tenantId,
        band: decision.effectiveBand,
        actions: decision.action ? [decision.action] : [],
        reserved: policyRows?.reserved ?? [],
      });
    }
  }
}

main().catch((err) => {
  console.error('[agents] fatal:', err);
  process.exit(1);
});