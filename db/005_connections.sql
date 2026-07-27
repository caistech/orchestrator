-- Connections — the tenant's authorisation to read their own systems.
--
-- This is the table that turns the entity index from a seed into a projection of a real business.
-- It holds OAuth tokens for a tenant's Xero (and later MYOB, Google, Simpro), which makes it the
-- most sensitive table in this database: a refresh token here is standing access to a business's
-- complete financial position.
--
-- Consequences, all deliberate:
--
--   * RLS on, no policies — service role only. Nothing authenticated as a user ever reads this, and
--     there is no "read your own connection" policy because there is no reason for a browser to
--     hold these bytes.
--   * Tokens are stored, not derived. Supabase encrypts at rest, which is the floor rather than the
--     ceiling; if this ever holds more than one real tenant, application-level encryption with a key
--     outside the database is the next step and should not wait for an incident to justify it.
--   * `revoked_at` rather than DELETE. A revoked connection must stay visible: "we no longer have
--     access to their Xero" is an operational fact the sweep needs, and a deleted row reads
--     identically to a tenant who was never connected.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS connections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  provider       text NOT NULL,                    -- 'xero' | 'myob' | 'google' | …
  -- The provider's own id for the organisation we were granted access to. Xero calls this the
  -- tenantId, which collides with ours — hence the explicit name.
  provider_org_id   text,
  provider_org_name text,

  access_token   text,
  refresh_token  text,
  -- Xero access tokens last 30 minutes and refresh tokens rotate on every use. A refresh that is
  -- not persisted immediately loses the connection permanently, so this column is written in the
  -- same statement as the new access token, never after it.
  expires_at     timestamptz,
  scopes         text,

  connected_at   timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  revoked_at     timestamptz,
  last_error     text,

  UNIQUE (tenant_id, provider, provider_org_id)
);

ALTER TABLE connections ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS connections_live_idx
  ON connections (tenant_id, provider) WHERE revoked_at IS NULL;

COMMENT ON TABLE connections IS
  'OAuth authorisations to read a tenant''s own systems. Service-role only — a refresh token here is standing access to a business''s finances.';

-- Where a short-lived OAuth state parameter lives between the redirect out and the callback back.
-- Separate from connections because it is not a connection yet, and because an unconsumed state must
-- expire rather than linger as a replayable token.
CREATE TABLE IF NOT EXISTS oauth_states (
  state       text PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
