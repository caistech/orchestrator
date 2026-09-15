-- 002_clarify.sql — T1: the clarify pass. Structural pre-gate for under-specified dispatches.
--
-- The clarifying state is NOT a convention in any adapter — it survives an adapter swap because it
-- lives on the task record: a task that entered the clarify loop carries its own count and TTL, and
-- the gate enforces both (DESIGN §5.1, /plan-eng-review D4).

-- 1) The status set grows 'clarifying'.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (
  status IN ('queued','awaiting_approval','scheduled','running','done','failed','unsupported','clarifying')
);

-- 2) The round-trip state, journaled on the row the loop owns.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS clarify_count  integer  NOT NULL DEFAULT 0,            -- rounds spent
  ADD COLUMN IF NOT EXISTS clarify_ttl_at timestamptz,                            -- auto-cancel deadline
  ADD COLUMN IF NOT EXISTS clarify_missing jsonb,                                 -- ['successCriteria','dueAt']…
  ADD COLUMN IF NOT EXISTS clarify_answers jsonb;                                 -- cumulative answers

-- 3) The TTL baton — the hourly housekeeping pass finds these.
CREATE INDEX IF NOT EXISTS tasks_clarify_ttl_idx ON tasks (clarify_ttl_at)
  WHERE status = 'clarifying';