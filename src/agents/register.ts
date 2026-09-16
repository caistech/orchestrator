// The agent register — what this system is able to DO, as data.
//
// WHY THIS EXISTS. The dispatch route classifies an intent into a kind (quote, email, reminder,
// unsupported), but the kind alone does not tell the system HOW to execute it — the dispatch route
// currently hard-codes the draft-and-hold path for three owned kinds, and everything else falls to
// `unsupported`. The agent registry closes that gap: it declares which agents exist, which read
// tools they may use, which model they run on, and which flows they unlock. The runner reads this
// at runtime to execute the async agent loop.
//
// SAFETY: agents may ONLY reference tools with class 'read' from config/tools.json. An agent that
// references an effect tool is rejected at load time — agents emit effects through the outbox;
// they never hold the ability to act. This is the read/effect split enforced structurally, not by
// convention (see tools/register.ts §17).
//
// Mirrors the tools register pattern: config here, binding in runner.ts. `npm run check:agents`
// asserts parity — an agent registered here but missing a runner binding is a bug, not config.

import registerJson from '../../config/agents.json';

/**
 * The tier an agent operates at. Mechanical (deterministic) agents run synchronously in the
 * dispatch route; conversational and agentic agents may run async with iteration loops.
 */
export type AgentTier = 'M' | 'C' | 'A' | 'H';

export interface AgentEntry {
  /** Stable identifier. References in task_events and payload.agent_id. */
  id: string;
  /** Human-readable description of what this agent does. */
  function: string;
  /** Read-only tool kinds from config/tools.json this agent may call. NEVER effect kinds. */
  tools: string[];
  /** The LLM model identifier for this agent's planning calls. */
  model: string;
  /** Hard cap on planning iterations. 1 = single-shot (no loop). */
  maxIterations: number;
  /** Hard cap on token cost in AUD. Runner hard-stops when reached. */
  maxCost: number;
  /** Registry flow ids this agent handles — makes sequencing computable. */
  flowsUnlocked: string[];
  notes?: string;
}

interface AgentsFile {
  version: number;
  agents: AgentEntry[];
}

/**
 * Validation THROWS rather than filtering.
 *
 * Same reasoning as tools/register.ts: an agent that is silently skipped is worse than a loud
 * rejection, because the dispatch route would route to a non-existent agent and the task would
 * sit in `unsupported` — the failure mode of "looks configured, isn't" is worse than "refused to
 * load".
 */
function validate(raw: unknown): AgentEntry[] {
  const file = raw as AgentsFile;
  if (!file || !Array.isArray(file.agents)) {
    throw new Error('config/agents.json: expected { version, agents: [...] }');
  }

  const seen = new Set<string>();
  for (const a of file.agents) {
    if (!a?.id || typeof a.id !== 'string') {
      throw new Error('config/agents.json: every agent needs a non-empty `id`.');
    }
    if (seen.has(a.id)) {
      throw new Error(`config/agents.json: duplicate agent id "${a.id}".`);
    }
    seen.add(a.id);

    if (!a.function || typeof a.function !== 'string') {
      throw new Error(`config/agents.json: agent "${a.id}" needs a function description.`);
    }
    if (!Array.isArray(a.tools)) {
      throw new Error(`config/agents.json: agent "${a.id}" needs a tools array.`);
    }
    if (!a.model || typeof a.model !== 'string') {
      throw new Error(`config/agents.json: agent "${a.id}" needs a model.`);
    }
    if (typeof a.maxIterations !== 'number' || a.maxIterations < 1) {
      throw new Error(`config/agents.json: agent "${a.id}" needs maxIterations >= 1.`);
    }
    if (typeof a.maxCost !== 'number' || a.maxCost <= 0) {
      throw new Error(`config/agents.json: agent "${a.id}" needs maxCost > 0.`);
    }
    if (!Array.isArray(a.flowsUnlocked)) {
      throw new Error(`config/agents.json: agent "${a.id}" needs flowsUnlocked (use [] if none yet).`);
    }
  }
  return file.agents;
}

const AGENTS: AgentEntry[] = validate(registerJson);

/** Every registered agent. */
export function allAgents(): AgentEntry[] {
  return AGENTS;
}

/** Look up an agent by id. Returns null when no agent handles this kind. */
export function agentFor(id: string): AgentEntry | null {
  return AGENTS.find((a) => a.id === id) ?? null;
}

/**
 * Find the agent that handles a given task kind. The dispatch route classifies intent into a
 * kind (quote, email, reminder); this function maps that kind to the agent responsible.
 *
 * The mapping is EXPLICIT rather than derived (`${kind}_agent`) because the registry names
 * agents by FUNCTION — 'quoting_agent', not 'quote_agent' — and a string-concatenation mapping
 * would silently route a new kind to a non-existent agent. An explicit table fails loudly at
 * registration when a kind has no owner.
 */
const KIND_TO_AGENT: Record<string, string> = {
  quote: 'quoting_agent',
  email: 'email_agent',
  reminder: 'reminder_agent',
  compliance: 'compliance_sweeper',
};

/** Every kind the dispatch route can classify, mapped to the agent that owns it. */
export function kindsOwnedBy(agentId: string): string[] {
  return Object.entries(KIND_TO_AGENT).filter(([, id]) => id === agentId).map(([kind]) => kind);
}

export function agentForKind(kind: string): AgentEntry | null {
  const agentId = KIND_TO_AGENT[kind];
  if (!agentId) return null;
  return agentFor(agentId);
}

/**
 * Find the agent that unlocks a registry flow id. Flows are declared per agent in config as
 * `flowsUnlocked`; the sweeper emits tasks carrying a flow id, and attribution to an agent is
 * exactly what the evidence collector needs to map mechanical sweep work into genome buckets.
 *
 * A sweep flow with no unlocking agent is still swept — the sweep is the mechanism, the agent is
 * the attribution — so this returns null rather than inventing an owner.
 */
export function agentForFlow(flow: string): AgentEntry | null {
  return AGENTS.find((a) => a.flowsUnlocked.includes(flow)) ?? null;
}

/**
 * All registry flow ids across every agent. Used by the sweeper to tag task attribution without
 * importing the registry per-rule — a flow id that unlocks no agent stays null (still swept).
 */
export function allRegisteredFlows(): string[] {
  const flows = new Set<string>();
  for (const a of AGENTS) {
    for (const f of a.flowsUnlocked) flows.add(f);
  }
  return [...flows];
}

/** All tool kinds referenced by any agent. Used by check:agents to verify they exist in tools.json. */
export function allAgentToolRefs(): string[] {
  const refs = new Set<string>();
  for (const a of AGENTS) {
    for (const t of a.tools) refs.add(t);
  }
  return [...refs];
}
