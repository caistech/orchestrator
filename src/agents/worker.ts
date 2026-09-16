// The agent worker — the background execution of the doing-layer, callable from any host.
//
// Mirrors src/sweeper.ts: `sweep(opts)` is a plain function the CLI script AND the cron route
// both call. Splitting the work from the hosting is what lets Vercel crons, a local `npm run agents`,
// and a future supervisor share the SAME execution path — a cron route that re-implements the loop
// would drift from the script, and drift is how a gate gets skipped.
//
// AGENTIC_NETWORK.md §3: "The loop runs ASYNC... Everything that iterates runs in the background;
// status via /v1/tasks; callback notifies."
//
// The function:
//   1. Pulls agent-dispatched tasks (status queued|running, agent_id set).
//   2. Runs the plan→read→emit loop (src/agents/runner.ts) per task.
//   3. On completion, stages Genome evidence (src/genome/evidence-collector.ts) and opens the
//      outcome window for the ratchet.
//   4. Runs the trust ratchet over closed outcome windows and writes promotions/demotions to the
//      tenant's delegation_policy.

import type { SupabaseClient } from '@supabase/supabase-js';

import { agentFor } from './register';
import { runAgentTask } from './runner';
import { collectEvidence, persistStaging } from '../genome/evidence-collector';
import { evaluateRatchet, applyRatchetToPolicy } from './ratchet';
import type { Band } from '../gate';

/** How long after a completed task before its outcome counts as clean, for the ratchet. */
const OUTCOME_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
/** Minimum consecutive clean outcomes before an action's delegation band is promoted. */
const RATCHET_PROMOTION_THRESHOLD = 5;

export interface AgentRunOutcome {
  taskId: string;
  agentId: string;
  status: string;
  iterations: number;
  totalCost: number;
  effectKind?: string;
}

export interface RatchetRunOutcome {
  key: string;
  currentBand: string;
  effectiveBand: string;
  reason: string;
}

export interface AgentWorkerReport {
  processed: number;
  runs: AgentRunOutcome[];
  stagedEvidence: number;
  evidenceErrors: number;
  ratchets: RatchetRunOutcome[];
}

export interface AgentWorkerOptions {
  supabase: SupabaseClient;
  /** OpenAI API key for the planning calls. Absent on cron hosts that never run planning agents. */
  apiKey: string;
  /** True when the worker should decide and mutate. False = report only. */
  apply: boolean;
}

export async function runAgentWorker(opts: AgentWorkerOptions): Promise<AgentWorkerReport> {
  const { supabase, apiKey, apply } = opts;
  const report: AgentWorkerReport = { processed: 0, runs: [], stagedEvidence: 0, evidenceErrors: 0, ratchets: [] };

  // ── Step 1: pull agent-dispatched tasks ────────────────────────────────────
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('id, tenant_id, utterance, payload, agent_id, status')
    .in('status', ['queued', 'running'])
    .not('agent_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(50);

  if (error) {
    throw new Error(`could not read agent tasks: ${error.message}`);
  }
  report.processed = tasks?.length ?? 0;

  for (const task of tasks ?? []) {
    const agent = agentFor(task.agent_id);
    if (!agent) {
      // An unregistered agent id on a task is the loud failure mode — a task routed to nothing.
      // Journal it and move on; the task stays pending for a human.
      console.error(`[worker] task ${task.id} references unknown agent "${task.agent_id}"`);
      report.runs.push({ taskId: task.id, agentId: task.agent_id, status: 'unknown_agent', iterations: 0, totalCost: 0 });
      if (apply) {
        await supabase.from('tasks').update({ status: 'failed', summary: `unknown agent ${task.agent_id}` }).eq('id', task.id);
      }
      continue;
    }

    // An effect ALREADY exists for this task — it is mechanical work the sweeper emitted directly
    // (tier-M flow tasks, AGENTIC_NETWORK §4), not a plan the loop owes. Agent-attributed sweeps
    // carry agent_id for EVIDENCE attribution, but running the loop on them would emit a SECOND
    // effect for work that already happened. Skip the loop; stage evidence from the existing
    // effect and open the outcome window, which is the whole point of the mechanical tag.
    const { data: existingEffects, error: existingError } = await supabase
      .from('effects')
      .select('id, kind, request, status')
      .eq('task_id', task.id);
    if (existingError) {
      throw new Error(`could not read effects for task ${task.id}: ${existingError.message}`);
    }
    if (existingEffects && existingEffects.length > 0) {
      report.runs.push({ taskId: task.id, agentId: agent.id, status: 'existing_effect', iterations: 0, totalCost: 0, effectKind: existingEffects[0].kind });
      if (apply) {
        const staging = collectEvidence(
          { id: existingEffects[0].id, task_id: task.id, kind: existingEffects[0].kind, request: existingEffects[0].request },
          { tenant_id: task.tenant_id, payload: task.payload },
        );
        if (staging.length > 0) {
          const { inserted, errors: stageErrors } = await persistStaging(supabase, staging);
          report.stagedEvidence += inserted;
          report.evidenceErrors += stageErrors;
        }
        await supabase.from('tasks').update({
          ratchet_band: 'approve_before_send',
          ratchet_outcome_at: new Date(Date.now() + OUTCOME_WINDOW_MS).toISOString(),
        }).eq('id', task.id);
      }
      continue;
    }

    if (!apply) {
      report.runs.push({ taskId: task.id, agentId: agent.id, status: 'would_run', iterations: 0, totalCost: 0 });
      continue;
    }

    try {
      const result = await runAgentTask({
        supabase,
        task: { id: task.id, tenant_id: task.tenant_id, utterance: task.utterance, payload: task.payload },
        agent,
        apiKey,
      });

      report.runs.push({
        taskId: task.id,
        agentId: agent.id,
        status: result.status,
        iterations: result.iterations,
        totalCost: result.totalCost,
        effectKind: result.effect?.kind,
      });

      if (result.status === 'completed' && result.effect) {
        // Completed effects are evidence, but they land in staging — a human promotes them into
        // the Genome (AGENTIC_NETWORK.md §1.4).
        const staging = collectEvidence(
          { id: task.id, task_id: task.id, kind: result.effect.kind, request: result.effect.request },
          { tenant_id: task.tenant_id, payload: task.payload },
        );
        if (staging.length > 0) {
          const { inserted, errors: stageErrors } = await persistStaging(supabase, staging);
          report.stagedEvidence += inserted;
          report.evidenceErrors += stageErrors;
        }
        // Open the outcome window so the ratchet can later count this task.
        await supabase.from('tasks').update({
          ratchet_band: 'approve_before_send',
          ratchet_outcome_at: new Date(Date.now() + OUTCOME_WINDOW_MS).toISOString(),
        }).eq('id', task.id);
      }

      if ((result.status === 'failed' || result.status === 'cap_exceeded') && apply) {
        // Fail the task and journal it — the owner must hear about a task that cannot be done,
        // never be told nothing.
        await supabase.from('tasks').update({
          status: 'failed',
          result: { agent_id: agent.id, error: result.reason, iterations: result.iterations, totalCost: result.totalCost },
        }).eq('id', task.id);
      }
    } catch (runError) {
      console.error(`[worker] task ${task.id} run threw:`, runError);
      report.runs.push({ taskId: task.id, agentId: agent.id, status: 'threw', iterations: 0, totalCost: 0 });
      if (apply) {
        await supabase.from('tasks').update({
          status: 'failed',
          result: { agent_id: agent.id, error: String(runError) },
        }).eq('id', task.id);
      }
    }
  }

  // ── Step 2: the trust ratchet over closed outcome windows ──────────────────
  // A task whose outcome window has closed receives its outcome. If enough of them are clean, the
  // ratchet promotes the delegation band for that action; a single dirty one strips it. This is the
  // "business detaches from the owner" mechanism: what the system may do without approval grows —
  // on evidence, not on vibes.
  if (!apply) return report;

  const closed = await supabase
    .from('tasks')
    .select('id, tenant_id, status, ratchet_band, ratchet_outcome_clean, flow, agent_id')
    .not('ratchet_outcome_at', 'is', null)
    .lt('ratchet_outcome_at', new Date().toISOString());

  if (closed.error) {
    console.error('[worker] could not read closed outcomes:', closed.error.message);
    return report;
  }

  for (const task of closed.data ?? []) {
    await supabase.from('tasks').update({
      ratchet_outcome_clean: task.ratchet_outcome_clean ?? (task.status === 'done' ? true : false),
    }).eq('id', task.id);
  }

  // Group by (tenant, action) and evaluate.
  const groups = new Map<string, typeof closed.data>();
  for (const task of closed.data ?? []) {
    const action = task.flow ?? task.agent_id ?? 'unknown';
    const key = `${task.tenant_id}:${action}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(task);
  }

  for (const [key, tasks] of groups) {
    const [tenantId] = key.split(':');
    const action = key.split(':').slice(1).join(':');

    const { data: policyRows } = await supabase
      .from('delegation_policy')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    const currentBand = (policyRows?.band as Band | undefined) ?? 'approve_before_send';

    const outcomes = (tasks ?? []).map((t) => ({
      taskId: t.id,
      tenantId,
      action,
      completedAt: new Date().toISOString(), // window closed now
      success: t.ratchet_outcome_clean ?? true,
      resolvedBand: currentBand,
    }));

    if (outcomes.length === 0) continue;

    const decision = evaluateRatchet(
      policyRows ?? { bands: {}, reserved: [] },
      outcomes,
      { currentBand, promotionThreshold: RATCHET_PROMOTION_THRESHOLD },
    );

    report.ratchets.push({
      key,
      currentBand: decision.currentBand,
      effectiveBand: decision.effectiveBand,
      reason: decision.reason,
    });

    const updated = applyRatchetToPolicy(policyRows ?? { bands: {}, reserved: [] }, decision);
    if (updated) {
      await supabase.from('delegation_policy').upsert({
        tenant_id: tenantId,
        band: decision.effectiveBand,
        actions: decision.action ? [decision.action] : [],
        reserved: policyRows?.reserved ?? [],
      });
    }
  }

  return report;
}