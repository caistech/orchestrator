-- 010_agent_network.sql — the doing-layer persistence (AGENTIC_NETWORK.md).
--
-- Three things, and no more:
--
-- 1) evidence_staging — the Genome staging/review area. Evolution of EVIDENCE_COLLECTOR:
--    completed effects land here as pending review; a HUMAN promotes them into the Genome.
--    We never let an agent write the Genome (AGENTIC_NETWORK.md §1.4).
--
-- 2) tasks.agent_id — records WHICH agent handled a task, for the continuity dashboard.
--    It duplicates nothing (agents are config, not rows); it is the audit trail of "which
--    specialist did this work".
--
-- 3) tasks.ratchet_* — the per-task outcome snapshots the trust ratchet (src/agents/ratchet.ts)
--    computes on. The ratchet reads these; it never stores its own mutable state, because the
--    ratchet's whole point is that it is DERIVED from outcomes, and a stored copy of the derived
--    value is how promotions silently fail to reverse.
--
-- Idempotent.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. evidence_staging
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS evidence_staging (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id       uuid,                                     -- the task whose completion produced this evidence
  effect_id     uuid,                                     -- the concrete effect that proved it
  effect_kind   text NOT NULL,                            -- 'email.send', 'compliance.expiry', …
  genome_bucket text NOT NULL,                            -- which Genome bucket this supports
  description   text NOT NULL,                            -- what this evidence proves, in words
  maturity_level integer NOT NULL DEFAULT 1 CHECK (maturity_level BETWEEN 0 AND 7),
  evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,       -- the raw completed effect request
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','reviewed','promoted','rejected')),
  reviewer_notes text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_at   timestamptz,
  UNIQUE (effect_id, genome_bucket)
);

CREATE INDEX IF NOT EXISTS evidence_staging_tenant_status_idx
  ON evidence_staging (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS evidence_staging_pending_idx
  ON evidence_staging (status) WHERE status = 'pending';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. tasks.agent_id — which specialist did this work
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_id text;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. tasks.ratchet_* — the outcome snapshot for delegation-band promotion
-- ─────────────────────────────────────────────────────────────────────────────

-- The band the gate resolved to when this task was dispatched.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ratchet_band text;

-- True when this task's outcome was clean (no complaint/rework within the window).
-- Null until the outcome-window closes; the ratchet only counts rows where this is non-null.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ratchet_outcome_clean boolean;

-- ISO timestamp when the outcome window closes (completion + window).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ratchet_outcome_at timestamptz;

-- Fast lookup: tasks whose outcome window has closed but which have not been counted.
CREATE INDEX IF NOT EXISTS tasks_ratchet_uncounted_idx
  ON tasks (ratchet_outcome_at)
  WHERE status = 'done' AND ratchet_outcome_clean IS NULL;