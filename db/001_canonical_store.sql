-- Orchestrator — the canonical store.
--
-- Two halves, and the line between them is the whole design (ORCHESTRATOR_SPEC §9):
--
--   > We own our own records completely, and nobody else's business records at all.
--
-- HALF ONE — the ENTITY INDEX (§9, projected by default). A business of the avatar's size already
-- runs Xero, and probably Simpro or ServiceM8. Those systems own the contacts, jobs, quotes and
-- invoices, and they own them well. Insisting on being the system of record turns every conversation
-- into a rip-and-replace, which is the hardest sale there is. So this is an INDEX — a stable local
-- id to hang tasks off, enough attributes to resolve "Dave Ellis" to that id, resolve a gate band,
-- and fire a threshold sweep, plus a pointer home. Two tables, not fourteen.
--
-- HALF TWO — our OPERATIONAL records, owned absolutely, because nobody else holds them: tasks,
-- events, effects, drafts, approvals, the delegation policy, and the log of what we could not route.
--
-- DETECTION VERSUS DECISION. A projection is stale the moment it is written, and the failure that
-- creates is concrete: chasing an invoice the client paid this morning. So the sweep reads the
-- projection to find CANDIDATES, and the handler confirms against the system of record before
-- emitting an effect. Where the source cannot be reached the task fails to the review queue with the
-- reason — degrade, don't fake (DATA_STANDARD R4).
--
-- Idempotent.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Tenancy
-- ─────────────────────────────────────────────────────────────────────────────
-- The flat owner key. Deliberately the SAME key Kira uses for memory and tasks
-- (GARETH_SHAH_INTEGRATION_SEAMS §Cross-cutting 23) so one business is one id across every system.

CREATE TABLE IF NOT EXISTS tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  timezone      text,                                -- IANA name; NULL = not captured (never an offset)
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The entity index  (§9 — an index, not a system of record)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS entities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- What kind of thing this is. Open text rather than an enum: the vertical packs add kinds we
  -- cannot enumerate now, and an enum migration per vertical is friction with no safety payoff.
  kind          text NOT NULL,                       -- contact | account | job | quote | invoice | asset | subcontractor | …

  -- WHO IS CANONICAL. 'projected' = their system owns it and this row is an index; 'authoritative'
  -- = nobody else holds it, so we do (compliance docs, certificate expiries, follow-up state).
  -- Handlers do not branch on this; the CONFIRM step does.
  mode          text NOT NULL DEFAULT 'projected' CHECK (mode IN ('projected','authoritative')),

  -- Pointer home. Null for authoritative rows, which have no home but here.
  source_system text,                                -- 'xero' | 'simpro' | 'servicem8' | …
  source_id     text,
  synced_at     timestamptz,

  -- (2) Resolution attributes — enough to turn "Dave Ellis" into this id.
  display_name  text NOT NULL,
  email         text,
  phone         text,

  -- (3) Gate attributes — enough for the delegation policy to resolve a band without a second
  -- lookup. A gate decision that needs a network call is a gate decision that gets skipped.
  account_type  text,                                -- 'trade' | 'consumer' | …
  value_band    text,

  -- (4) Sweep attributes — enough for a threshold rule to fire. These are the columns the
  -- generalised sweeper compares against now(); anything else it needs belongs here too.
  days_overdue      integer,
  last_contacted_at timestamptz,
  expires_on        date,

  -- Everything else the source returned, unflattened. Not for querying — for showing a human why a
  -- task fired without a round trip to the source.
  attributes    jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- One row per source record. Re-syncing upserts rather than duplicating — three agents writing
  -- three versions of the same client is the failure this layer exists to prevent.
  UNIQUE (tenant_id, source_system, source_id)
);

CREATE INDEX IF NOT EXISTS entities_tenant_kind_idx ON entities (tenant_id, kind);
CREATE INDEX IF NOT EXISTS entities_resolve_idx     ON entities (tenant_id, lower(display_name));
CREATE INDEX IF NOT EXISTS entities_email_idx       ON entities (tenant_id, lower(email)) WHERE email IS NOT NULL;

-- The sweep's access paths. Partial, because a threshold rule only ever looks at rows that have the
-- attribute at all, and those are a minority.
CREATE INDEX IF NOT EXISTS entities_overdue_idx  ON entities (tenant_id, days_overdue)      WHERE days_overdue IS NOT NULL;
CREATE INDEX IF NOT EXISTS entities_quiet_idx    ON entities (tenant_id, last_contacted_at) WHERE last_contacted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS entities_expiry_idx   ON entities (tenant_id, expires_on)        WHERE expires_on IS NOT NULL;

-- Aliases carry the names a human actually says. "Dave", "Dave E", "Ellis Plumbing" all resolve to
-- one row — which is what makes "chase Dave" routable without semantic search over clients
-- (§9 retrieval pattern: resolve to a canonical entity FIRST, then pull context against it).
CREATE TABLE IF NOT EXISTS entity_aliases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id     uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, alias)
);
CREATE INDEX IF NOT EXISTS entity_aliases_lookup_idx ON entity_aliases (lower(alias));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Our own operational records (§9 — owned absolutely)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- The idempotency key the CALLER supplies. One utterance, one sweep hit, one webhook — never
  -- dispatches twice, however many times it is delivered.
  intent_id     text NOT NULL,

  -- Which of the 140 registry flows this is, and which manifest resolved it.
  flow          text,                                -- e.g. '45' (chase 30-day)
  manifest      text,

  -- How it arrived. The reason this column exists at all: ~85% of flows begin with something other
  -- than a person speaking, and a system that cannot record that is voice-shaped.
  ingress       text NOT NULL CHECK (ingress IN ('EVT','STA','CAL','SAY','HUM')),
  tier          text          CHECK (tier    IN ('M','C','A','H')),

  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','awaiting_approval','scheduled','running','done','failed','unsupported')),

  subject_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,

  utterance     text,                                -- present for SAY; null for the other four
  summary       text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  result        jsonb,

  due_at        timestamptz,                         -- scheduled work; the sweeper's comparison column
  handled_by    text NOT NULL DEFAULT 'orchestrator',

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, intent_id)
);

CREATE INDEX IF NOT EXISTS tasks_tenant_status_idx ON tasks (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_due_idx           ON tasks (due_at) WHERE status = 'scheduled';

-- Append-only history. Without this, "why did this fire?" and "did it actually send?" are both
-- unanswerable, and both get asked the first time something goes wrong in front of a client.
CREATE TABLE IF NOT EXISTS task_events (
  id            bigserial PRIMARY KEY,
  task_id       uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  at            timestamptz NOT NULL DEFAULT now(),
  event         text NOT NULL,                       -- routed | gated | approved | rejected | executed | failed | …
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- One correlation id traces a single trigger across every hop (§Cross-cutting 25).
  correlation_id text
);
CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events (task_id, at);

-- Every INTENDED change to the world, recorded before it is attempted. This is the outbox, and it is
-- the only reason "did it actually send?" has an answer. Idempotency key is unique so a retry
-- re-uses the row rather than sending twice.
CREATE TABLE IF NOT EXISTS effects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind          text NOT NULL,                       -- email.send | invoice.create | calendar.book | …
  connector     text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  request       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','sent','failed','abandoned')),
  response      jsonb,
  attempts      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS effects_pending_idx ON effects (status, created_at) WHERE status = 'pending';

-- What an approval gate holds, and the surface it is held on.
CREATE TABLE IF NOT EXISTS drafts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  channel       text NOT NULL,                       -- email | sms | document | …
  subject       text,
  body          text NOT NULL,
  recipients    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  decided_by    text,                                -- who; null while pending
  decision      text CHECK (decision IN ('approved','rejected')),
  reason        text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
CREATE INDEX IF NOT EXISTS approvals_pending_idx ON approvals (task_id) WHERE decided_at IS NULL;

-- THE DELEGATION POLICY IS DATA, NOT CODE (TASK_REGISTRY §7).
--
-- One tenant policy governs all 140 flows. The alternative — a gate setting per flow — means editing
-- 140 rows to change one approval threshold, and nobody can then answer "what can this system do
-- without asking me?" without reading all of them.
--
-- Bands resolve from properties of the ACTION (consequence, spend, counterparty), never from the
-- flow's identity: a $60 top-up and a $60k order are the same flow and must gate differently.
--
-- It is data specifically so it survives replacing the orchestrator: swap ours for a vendor's and
-- the authority the owner granted comes with them.
CREATE TABLE IF NOT EXISTS delegation_policy (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version       integer NOT NULL DEFAULT 1,

  -- Bands, conservative by default. Shape: { "notify": {...}, "approve": {...}, "reserved": [...] }
  bands         jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- NEVER delegable at any authority level, whatever the bands say. Payroll disbursement, tax
  -- lodgement, termination, supplier bank-detail change, bad-debt write-off, capital purchase.
  -- Supplier bank details are the sharpest case: low volume, catastrophic, and the entire attack is
  -- convincing someone it is routine — so it must not be reachable by a limit that widens with trust.
  reserved      jsonb NOT NULL DEFAULT '["76","81","80","134","112","100"]'::jsonb,

  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version)
);

-- What we could not route. §5 of the spec calls this the source of truth for where the real
-- decomposition boundaries are — the registry's 140 flows are a guess until this table disagrees.
CREATE TABLE IF NOT EXISTS unroutable_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ingress       text NOT NULL,
  raw           text NOT NULL,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RLS — on every table, no exceptions (CLAUDE.md; DATA_STANDARD S2)
-- ─────────────────────────────────────────────────────────────────────────────
-- This is a service-role backend today, which is exactly the argument people use for skipping RLS
-- and exactly why it gets skipped until the day something else connects. The store holds a real
-- business's contact PII and financial positions — tenant zero is Global Buildtech Australia, whose
-- Xero data lands in `entities` — so an un-gated table is a live exposure, not a theoretical one.
--
-- Deny-by-default: enabling RLS with NO policy means nothing but the service role can read or write.
-- Per-tenant read policies get added alongside the review-queue UI, when there is an authenticated
-- human to scope them to; adding them now would be guessing at a session shape that does not exist.

ALTER TABLE tenants             ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities            ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_aliases      ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks               ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE effects             ENABLE ROW LEVEL SECURITY;
ALTER TABLE drafts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE delegation_policy   ENABLE ROW LEVEL SECURITY;
ALTER TABLE unroutable_requests ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. updated_at
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS entities_touch ON entities;
CREATE TRIGGER entities_touch BEFORE UPDATE ON entities
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS tasks_touch ON tasks;
CREATE TRIGGER tasks_touch BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
