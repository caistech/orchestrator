-- Two things the email connector cannot exist without.
--
-- 1. WHOSE NAME IS ON THE EMAIL.
--
-- The orchestrator sends on behalf of the TENANT — a plumbing business chasing its own customer —
-- not on behalf of Corporate AI Solutions. Australia's Spam Act requires the message to identify
-- the sender with a name, an ABN and a reply-capable address, and the sender here is the tenant.
-- Putting our ABN on a client's debt-chase would be the exact white-label failure PRODUCT_STANDARDS
-- §9 exists to prevent, and it would be worse than a missing footer because it is confidently wrong.
--
-- These are NULLABLE, and the connector REFUSES to send commercial mail without them rather than
-- degrading to a CAS identity or omitting the footer. An unconfigured tenant is a tenant nobody has
-- onboarded, and the correct behaviour is to stop, not to improvise.
--
-- 2. A CLAIM STATE ON THE OUTBOX.
--
-- 'pending' → 'sent' cannot be done safely in one step: mark-then-send double-sends on a crash
-- between the two, and send-then-mark double-sends on a concurrent run. So the drain CLAIMS a row
-- (pending → sending) with a conditional update that only one worker can win, then sends, then
-- records the outcome. The window where a crash loses a send is narrowed to the send itself, and a
-- stuck 'sending' row is visible rather than silently retried forever.
--
-- Idempotent.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS legal_name     text,
  ADD COLUMN IF NOT EXISTS abn            text,
  ADD COLUMN IF NOT EXISTS postal_address text,
  ADD COLUMN IF NOT EXISTS reply_email    text;

COMMENT ON COLUMN tenants.abn IS
  'The TENANT''s ABN — never Corporate AI Solutions''. This is the identity that appears in the Spam Act footer of mail this system sends on their behalf.';

-- Widen the effects status CHECK to admit the claim state.
ALTER TABLE effects DROP CONSTRAINT IF EXISTS effects_status_check;
ALTER TABLE effects ADD CONSTRAINT effects_status_check
  CHECK (status IN ('pending','sending','sent','failed','abandoned'));

-- Why a send failed, in the row, so a failure is diagnosable without reading logs.
ALTER TABLE effects
  ADD COLUMN IF NOT EXISTS error       text,
  ADD COLUMN IF NOT EXISTS claimed_at  timestamptz;

-- A row stuck in 'sending' is the one state that needs a human eye — it means a worker died
-- mid-send and we do not know whether the mail went out. Deliberately NOT auto-retried.
CREATE INDEX IF NOT EXISTS effects_claimed_idx ON effects (claimed_at) WHERE status = 'sending';

-- Suppression is a STATE, not a deletion (see @caistech/email-compliance): deleting a contact means
-- the next list import resurrects them. Keyed by EMAIL rather than a user id, because someone who
-- unsubscribes, deletes their account and signs up again with the same address has still told you
-- to stop.
CREATE TABLE IF NOT EXISTS email_suppressions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid REFERENCES tenants(id) ON DELETE CASCADE,
  email        text NOT NULL,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
ALTER TABLE email_suppressions ENABLE ROW LEVEL SECURITY;

-- Seed tenant gets an identity so the connector has something to send as. Real-looking rather than
-- real: this is the dev tenant, and it must never be mistaken for GBA's actual registration.
UPDATE tenants SET
  legal_name     = 'Seed Trading Co Pty Ltd (dev)',
  abn            = '00 000 000 000',
  postal_address = '1 Example Street, Perth WA 6000',
  reply_email    = 'accounts@seedtrading.invalid'
WHERE id = '00000000-0000-4000-a000-000000000001';
