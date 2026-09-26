// The agent runner — the async execution loop for agentic tasks.
//
// AGENTIC_NETWORK.md §3: "The loop runs ASYNC. Voice-sync is one model call (classify/clarify/
// draft). Everything that iterates runs in the background; status via /v1/tasks; callback notifies."
//
// This module is the doing-layer that replaces the LocalSwarmStub. It takes a task row and its
// agent config, executes the plan→read→eval→emit loop, and writes progress to task_events.
//
// SAFETY: agents may ONLY call read tools. Effect tools (email.send, email.draft) are NOT in an
// agent's tool set — a handler emits an effect, and the drain performs it once the gate has cleared.
// This inversion is what makes approval gates structurally true, not behaviourally hoped-for
// (EXECUTION_LAYER.md §6, TOOLS/register.ts §17).
//
// Caps are HARD STOPS, not warnings. The monotonic rule: once spent or iterated, never refunded.
// A cap breach sets task status to 'failed' with a clear reason — degrade, don't fake.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentEntry } from './register';
import { isExecutable } from '../tools/register';
import { findComparableWork, comparablesAsContext, type Comparable } from '../knowledge/past-pricing';
import { findMaterialCost, materialCostAsContext, type MaterialCost } from '../knowledge/material-cost';
import { currentQuoteFormat, formatAsInstructions } from '../knowledge/quote-format';
import {
  xeroConnectionFor,
  fetchUnreconciledBankTransactions,
  fetchChartOfAccounts,
  fetchCodingHistory,
} from '../connectors/xero';

// ── Read tool resolver ────────────────────────────────────────────────────────────────────────
//
// Maps tool kind names to actual functions. This is the "binding" half of the agent register,
// analogous to src/tools/executors.ts for effect tools. Static map, not dynamic import — same
// reason: serverless bundles resolve at build time, not runtime.

export interface ReadToolContext {
  supabase: SupabaseClient;
  tenantId: string;
  /** The utterance that triggered this task — needed for material cost lookup. */
  utterance?: string;
  /** Client name for past-pricing lookup. */
  recipientName?: string;
  /** The task's own payload, for tools whose scope is task-specific rather than tenant-wide
   *  (e.g. reconciliation: WHICH batch of transaction ids this particular task covers). */
  payload?: Record<string, unknown>;
}

/**
 * Resolve a live Xero connection + credentials once, for the three reconciliation read tools below.
 * Returns null (never throws) when the tenant has no connection — the tool's own result carries that
 * as data ("not_connected") rather than failing the whole planning loop, matching the read-tool
 * failure posture already established two lines below (a failed read tool degrades context, it does
 * not fail the task).
 */
async function resolveXero(ctx: ReadToolContext) {
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const connection = await xeroConnectionFor(ctx.supabase, ctx.tenantId);
  if (!connection) return null;
  return { connection, clientId, clientSecret };
}

export interface ReadToolResult {
  tool: string;
  data: Record<string, unknown>;
}

type ReadToolFn = (ctx: ReadToolContext) => Promise<Record<string, unknown>>;

const READ_TOOLS: Record<string, ReadToolFn> = {
  'past_pricing.read': async (ctx) => {
    const comparables = await findComparableWork(ctx.supabase, ctx.tenantId, {
      client: ctx.recipientName,
      description: ctx.utterance,
    });
    return { comparables, context: comparablesAsContext(comparables) };
  },
  'material_cost.read': async (ctx) => {
    const costs = await findMaterialCost(ctx.supabase, ctx.tenantId, ctx.utterance ?? '');
    return { materialCosts: costs, context: materialCostAsContext(costs) };
  },
  'quote_format.read': async (ctx) => {
    const stored = await currentQuoteFormat(ctx.supabase, ctx.tenantId);
    return { format: stored, instructions: stored ? formatAsInstructions(stored) : null };
  },
  // ── Bank reconciliation categorisation (Phase 1) ─────────────────────────────────────────────
  // See docs/BANK_RECONCILIATION_SKILL_SCOPE.md. All three GET-only; none can write to Xero.
  'bank_transactions.read': async (ctx) => {
    const xero = await resolveXero(ctx);
    if (!xero) return { connected: false, lines: [] };

    const page = Number(ctx.payload?.page ?? 1);
    const batchIds = new Set((ctx.payload?.transaction_ids as string[] | undefined) ?? []);

    const { lines } = await fetchUnreconciledBankTransactions(ctx.supabase, xero.connection, xero.clientId, xero.clientSecret, { page });
    // Filter to exactly the ids the detector assigned to THIS task — the page may have moved on by
    // the time the worker runs, and this task must only ever propose for the batch it was given.
    const scoped = batchIds.size ? lines.filter((l) => batchIds.has(l.bankTransactionId)) : lines;
    return { connected: true, lines: scoped };
  },
  'chart_of_accounts.read': async (ctx) => {
    const xero = await resolveXero(ctx);
    if (!xero) return { connected: false, accounts: [] };
    const accounts = await fetchChartOfAccounts(ctx.supabase, xero.connection, xero.clientId, xero.clientSecret);
    return { connected: true, accounts };
  },
  'coding_history.read': async (ctx) => {
    const xero = await resolveXero(ctx);
    if (!xero) return { connected: false, examples: [] };
    const examples = await fetchCodingHistory(ctx.supabase, xero.connection, xero.clientId, xero.clientSecret, { limit: 50 });
    return { connected: true, examples };
  },
};

/**
 * Resolve a tool kind to its handler. Returns null for unregistered tools — the runner
 * should never call a tool that does not exist in this map. An effect tool referenced
 * here would be caught by the register validation, but this is defence in depth.
 */
export function resolveReadTool(kind: string): ReadToolFn | null {
  return READ_TOOLS[kind] ?? null;
}

// ── Planning prompt construction ───────────────────────────────────────────────────────────────

function buildPlanPrompt(
  agent: AgentEntry,
  utterance: string,
  toolResults: ReadToolResult[],
): string {
  const toolContext = toolResults
    .map((r) => `[${r.tool}]\n${JSON.stringify(r.data, null, 2)}`)
    .join('\n\n');

  // The reconciliation agent is STA-triggered (a cron detector, not a spoken utterance) and never
  // emits an effect — a "stage_review" plan writes proposals to the review queue only. It needs its
  // own prompt shape rather than the "Owner said" framing every SAY-triggered agent below shares,
  // since there is no utterance and nothing here may ever write to Xero.
  if (agent.id === 'reconciliation_agent') {
    return [
      `You are executing the task: "${agent.function}".`,
      '',
      'You NEVER write to Xero. Your only output is a proposed categorisation per transaction, for a',
      'human (the business owner, then their accountant) to review and confirm.',
      '',
      toolContext ? `Context from read tools:\n${toolContext}` : '',
      '',
      'For EACH unreconciled line in bank_transactions.read\'s "lines", propose a categorisation using',
      'ONLY account codes present in chart_of_accounts.read, informed by coding_history.read (how this',
      'business has actually coded similar-looking lines before — prefer a documented prior pattern',
      'over a generic guess). If a line looks like a personal (non-business) transaction and there is',
      'no confident prior pattern for it, say so plainly rather than guessing at a business category.',
      '',
      'Produce a JSON object with:',
      '  "action": "stage_review"',
      '  "summary": one line, e.g. "23 transactions categorised, 2 flagged as possibly personal"',
      '  "proposals": an array, one entry per line in bank_transactions.read, each:',
      '    { "bankTransactionId": ..., "description": ..., "amount": ...,',
      '      "proposedAccountCode": string or null, "proposedContact": string or null,',
      '      "proposedTaxType": string or null, "confidence": "high"|"medium"|"low",',
      '      "rationale": one short sentence, "possiblyPersonal": boolean }',
      'Reply with ONLY that JSON object.',
    ].filter(Boolean).join('\n');
  }

  return [
    `You are executing the task: "${agent.function}".`,
    '',
    `Owner said: "${utterance}"`,
    '',
    toolContext ? `Context from read tools:\n${toolContext}` : '',
    '',
    'Produce a JSON object with:',
    '  "action": one of ["draft_email", "draft_quote", "set_reminder", "send_notification"]',
    '  "summary": one-line summary for the owner',
    '  "preview": full content (email body, quote text, or notification)',
    '  "artifact": structured payload for the effect (to, subject, due_at, etc.)',
    '',
    'NEVER include a "Subject:" line inside the body. The subject is a separate field.',
    'NEVER write placeholders like [Owner\'s Name]. Sign off naturally.',
  ].filter(Boolean).join('\n');
}

// ── Effect emission ────────────────────────────────────────────────────────────────────────────

export interface EffectEmission {
  kind: string;
  connector: string;
  idempotencyKey: string;
  request: Record<string, unknown>;
}

export interface RunResult {
  taskId: string;
  agentId: string;
  iterations: number;
  totalCost: number;
  effect: EffectEmission | null;
  status: 'completed' | 'failed' | 'cap_exceeded';
  reason?: string;
}

// ── The runner ─────────────────────────────────────────────────────────────────────────────────

export interface RunContext {
  supabase: SupabaseClient;
  task: {
    id: string;
    tenant_id: string;
    utterance?: string;
    payload?: Record<string, unknown>;
  };
  agent: AgentEntry;
  /** OpenAI API key for the planning model. */
  apiKey: string;
  /** Injected time for reproducible tests. */
  now?: Date;
}

/**
 * Execute an agent's task. The loop:
 *   1. Call read tools declared in the agent's tool list
 *   2. Build a plan prompt with context
 *   3. Call the LLM for a structured plan
 *   4. Emit the resulting effect to the outbox
 *   5. Enforce iteration and cost caps at every step
 *
 * The agent NEVER calls effect tools. It emits effects; the drain performs them.
 * This is the structural separation that makes approval gates real.
 */
export async function runAgentTask(ctx: RunContext): Promise<RunResult> {
  const { supabase, task, agent, apiKey, now } = ctx;
  const startTime = now ?? new Date();
  let iterations = 0;
  let totalCost = 0;

  const fail = (status: 'failed' | 'cap_exceeded', reason: string): RunResult => ({
    taskId: task.id,
    agentId: agent.id,
    iterations,
    totalCost,
    effect: null,
    status,
    reason,
  });

  // ── Step 1: Read tools ─────────────────────────────────────────────────────────────────────
  const readCtx: ReadToolContext = {
    supabase,
    tenantId: task.tenant_id,
    utterance: task.utterance,
    recipientName: (task.payload?.recipient_name as string) ?? undefined,
    payload: task.payload,
  };

  const toolResults: ReadToolResult[] = [];
  for (const toolKind of agent.tools) {
    if (isExecutable(toolKind)) {
      // Belt and suspenders: the register should never allow an effect tool in an agent's list,
      // but if it somehow did, we refuse to call it here rather than silently letting an agent
      // reach the world directly.
      console.error(`[runner] agent "${agent.id}" references effect tool "${toolKind}" — refusing`);
      continue;
    }

    const fn = resolveReadTool(toolKind);
    if (!fn) {
      console.warn(`[runner] agent "${agent.id}" references unregistered read tool "${toolKind}" — skipped`);
      continue;
    }

    try {
      const data = await fn(readCtx);
      toolResults.push({ tool: toolKind, data });
    } catch (e) {
      // Read tool failure is a soft error — the agent proceeds with partial context.
      // Degrade, don't fake (DATA_STANDARD R4).
      console.error(`[runner] read tool "${toolKind}" failed for task ${task.id}:`, e);
      toolResults.push({ tool: toolKind, data: { error: String(e) } });
    }
  }

  // ── Step 2: Plan (LLM call) ────────────────────────────────────────────────────────────────
  iterations += 1;

  if (iterations > agent.maxIterations) {
    return fail('cap_exceeded', `exceeded maxIterations (${agent.maxIterations})`);
  }

  const prompt = buildPlanPrompt(agent, task.utterance ?? '', toolResults);

  let planResult: Record<string, unknown> | null = null;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: agent.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a task-planning agent. Reply with ONLY a JSON object.' },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      return fail('failed', `LLM call failed: ${res.status}`);
    }

    const json = await res.json();
    const inputTokens = json?.usage?.prompt_tokens ?? 0;
    const outputTokens = json?.usage?.completion_tokens ?? 0;

    // Approximate cost: gpt-4.1-mini at ~$0.15/1M input, ~$0.60/1M output (AUD approximation).
    const estimatedCost = (inputTokens * 0.00015 + outputTokens * 0.0006);
    totalCost += estimatedCost;

    if (totalCost > agent.maxCost) {
      return fail('cap_exceeded', `exceeded maxCost $${agent.maxCost} (spent $${totalCost.toFixed(4)})`);
    }

    try {
      planResult = JSON.parse(json?.choices?.[0]?.message?.content ?? '{}');
    } catch {
      return fail('failed', 'LLM returned non-JSON response');
    }
  } catch (e) {
    return fail('failed', `LLM call error: ${String(e)}`);
  }

  if (!planResult) {
    return fail('failed', 'plan produced no result');
  }

  // ── Reconciliation categorisation: stage for review, never an effect ──────────────────────
  //
  // This agent has NO effect tool in its registry entry (config/agents.json) — structurally, not
  // just by convention, it cannot reach Xero. Its plan action is always "stage_review": write the
  // proposed categorisations into `drafts` (the existing "what an approval gate holds" table,
  // channel 'reconciliation_review') and hold them in `approvals`. No `effects` row is ever created
  // for this action — Phase 1 makes zero writes to Xero (docs/BANK_RECONCILIATION_SKILL_SCOPE.md).
  if (String(planResult.action ?? '') === 'stage_review') {
    const proposals = Array.isArray(planResult.proposals) ? planResult.proposals : [];
    const summary = String(planResult.summary ?? `${proposals.length} transactions categorised`);

    const { error: draftError } = await supabase.from('drafts').insert({
      task_id: task.id,
      channel: 'reconciliation_review',
      subject: summary,
      body: JSON.stringify(proposals, null, 2),
      recipients: [],
    });
    if (draftError) {
      return fail('failed', `draft write failed: ${draftError.message}`);
    }

    await supabase.from('tasks').update({
      status: 'awaiting_approval',
      summary,
      result: { agent_id: agent.id, iterations, totalCost, action: 'stage_review', proposalCount: proposals.length },
    }).eq('id', task.id);

    await supabase.from('approvals').insert({ task_id: task.id });

    await supabase.from('task_events').insert({
      task_id: task.id,
      event: 'agent_completed',
      detail: { agent_id: agent.id, iterations, totalCost, action: 'stage_review', proposalCount: proposals.length },
    });

    return { taskId: task.id, agentId: agent.id, iterations, totalCost, effect: null, status: 'completed' };
  }

  // ── Step 3: Map plan to effect ─────────────────────────────────────────────────────────────
  //
  // The plan decides WHAT to do. The effect is HOW it reaches the world.
  // The agent never holds the send capability — it emits an effect, and the drain
  // performs it after the gate has cleared.

  const action = String(planResult.action ?? '');
  const summary = String(planResult.summary ?? '');
  const preview = String(planResult.preview ?? '');
  const artifact = (planResult.artifact as Record<string, unknown>) ?? {};

  let effectKind: string;
  let connector: string;

  switch (action) {
    case 'draft_email':
      effectKind = 'email.draft';
      connector = 'google';
      break;
    case 'draft_quote':
      // Quotes that leave the building go through email.send with a specific delivery path.
      // The draft path is the safe default; the approve route upgrades to send.
      effectKind = 'email.draft';
      connector = 'google';
      break;
    case 'set_reminder':
      // Reminders are scheduled email.send at the due time. The outbox + drain handles timing.
      effectKind = 'email.send';
      connector = 'resend';
      break;
    case 'send_notification':
      effectKind = 'email.send';
      connector = 'resend';
      break;
    default:
      return fail('failed', `unrecognised plan action "${action}"`);
  }

  const effect: EffectEmission = {
    kind: effectKind,
    connector,
    idempotencyKey: `agent:${agent.id}:${task.id}:${iterations}`,
    request: {
      to: artifact.to ?? (task.payload?.recipient_email as string) ?? null,
      subject: artifact.subject ?? summary,
      body: preview,
      ...(artifact.due_at ? { due_at: artifact.due_at } : {}),
    },
  };

  // ── Step 4: Emit to outbox ─────────────────────────────────────────────────────────────────
  //
  // The effect is written to the outbox BEFORE the task is marked complete — this is the
  // "confirmed, not assumed" property (EXECUTION_LAYER.md §5). If the outbox write fails,
  // the task stays 'running' and the next sweep retries.

  const { error: effectError } = await supabase.from('effects').insert({
    task_id: task.id,
    // The plan maps to a closed vocabulary (email.draft|email.send) — both registered, both
    // evidence-mapped (asserted by check:agents), so the dynamic kind is safe to emit.
    kind: effect.kind, // @effect-kind-dynamic: resolved from the plan's closed action vocabulary
    connector: effect.connector,
    idempotency_key: effect.idempotencyKey,
    request: effect.request,
  });

  if (effectError) {
    if ((effectError as { code?: string }).code === '23505') {
      // Idempotency key already exists — the effect was already emitted. This is not a failure;
      // it means the previous run succeeded past the outbox write. Log and succeed.
      console.log(`[runner] effect already emitted for task ${task.id} — idempotent hit`);
    } else {
      return fail('failed', `outbox write failed: ${effectError.message}`);
    }
  }

  // ── Step 5: Update task status ─────────────────────────────────────────────────────────────
  //
  // The task moves to 'awaiting_approval' — the gate holds it until a human decides.
  // This is the HITL boundary: the agent planned and drafted, but nothing sends without approval.

  await supabase.from('tasks').update({
    status: 'awaiting_approval',
    summary: summary || (task.utterance?.slice(0, 200) ?? null),
    result: { agent_id: agent.id, iterations, totalCost, action },
  }).eq('id', task.id);

  await supabase.from('task_events').insert({
    task_id: task.id,
    event: 'agent_completed',
    detail: { agent_id: agent.id, iterations, totalCost, action, effectKind: effect.kind },
  });

  return {
    taskId: task.id,
    agentId: agent.id,
    iterations,
    totalCost,
    effect,
    status: 'completed',
  };
}
