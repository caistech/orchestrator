# AGENTIC_NETWORK.md — the doing-layer design (v1)

Status: **Built** (2026-09-16) · supersedes no existing doc; builds the
EXECUTION_LAYER §4 tier-3 (agentic) handoff into a runnable design.
Prime directive: make the business run without the owner, evidenced, not claimed.

## 1. Non-negotiables (from the review — not weakened by later edits)
1. Read/effect split is structural. The agent loop is READ+PLAN; all world-changes are
   `effect` rows → outbox → gate → dispatcher. No agent holds a send capability.
2. The loop runs ASYNC. Voice-sync is one model call (classify/clarify/draft). Everything that
   iterates runs in the background; status via /v1/tasks; callback notifies.
3. The Gate outranks the agent. When delegation policy cannot resolve a band, the task holds.
   An agent may not widen its own authority.
4. The Genome is not written by agents. Evidence flows through a staging/review area and a
   bucket moves only on evidenced pathway milestones.

## 2. Components
- Agent Registry (`config/agents.json`) — agents named by function; declares model + tools. **Built.**
- Runner (`src/agents/runner.ts`) — executes the loop; read tools only; emits effects. **Built.**
- Router (enhanced `dispatch/route.ts`) — classify → registry lookup → sync draft or async loop. **Built.**
- Trust Ratchet (`src/agents/ratchet.ts`) — outcome-evidence promotions, reversible, capped. **Built.**
- Evidence Collector (`src/genome/evidence-collector.ts`) — effect→bucket mapping, staging first. **Built.**
- Worker (`src/agents/worker.ts`) — background executor, shared by cron route and CLI. Existing-effect guard prevents double-send. **Built.**
- Continuity Dashboard (`app/continuity/`) — quality-adjusted owner-independence metrics + alerts. **Built.**
- `check:agents` — asserts registry↔runner parity. An un-runnable agent is a bug, not config. **Built.**

## 3. The agent loop (tier 3, async)
dispatch → classify → [registry] → (sync: draft+clarify) | (async: run loop)
loop: plan → read tools → eval → emit effect → progress
effect → outbox → gate → dispatcher → connector → task_events → evidence collector → genome staging
caps: iteration budget, cost budget (from EXECUTION_LAYER §4.3) — enforced per task, hard stops.

## 4. First tranche (ships, proves the ratchet and evidence loop)
- quoting_agent — quote drafting with past-pricing + material-cost context; async loop.
- email_agent — recipient resolution + draft (Gmail draft, not send; effect path for send).
- reminder_agent — sweep-scheduled reminders; effects through gate.
- compliance_sweeper — the 7 existing rules, now feeding the evidence collector.
Model: existing gpt-4.1-mini family; registry declares, delegate decides.

## 5. Delegation and the ratchet
- Authority lives in `delegation_policy`, never in the registry.
- Ratchet input = outcome evidence (no downstream rework within window) not approval count.
- Promotion: approve_before_start → approve_before_send → notify → auto, per (tenant, action).
- Reversal: one material bad outcome strips the promoted level for that action.
- Caps: reserved list never ratchets; spend ceiling is owner-set and never removed.

## 6. Kira flip sequence (R9)
1. `KIRA_SWARM_ADAPTER=orchestrator` for Brian/CAI beta tenant; monitor the 3 owned kinds live.
2. Keep `local` stub as one-env-var fallback for one release.
3. Ratchet shows month-1 outcome evidence → expand to next distributors chunk.
4. Stub deleted only when zero production tenants reference it.

## 7. Definition of done (first tranche)
- check:agents green; 3 agents live under Kira→orchestrator; ratchet promoted ≥1 action
  on outcome evidence; evidence staging visible in continuity dashboard; 218+suite + new tests green.