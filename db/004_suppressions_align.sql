-- Align email_suppressions with @caistech/email-compliance's Supabase store.
--
-- The store upserts { email, reason, detail, suppressed_at } with onConflict: "email". My 003 table
-- had UNIQUE (tenant_id, email) and no detail/suppressed_at, so every unsubscribe would have failed
-- at the upsert — the one code path that must never fail, because the person is trying to leave.
--
-- SUPPRESSION IS GLOBAL, NOT PER TENANT, and that is a deliberate reading rather than an accident of
-- the package's shape. Over-suppressing is safe: the worst case is a business cannot email someone
-- who asked a different business to stop. Under-suppressing means honouring an opt-out for one
-- tenant and ignoring it for the next, which is the failure the Act actually punishes. If per-tenant
-- suppression is ever wanted it needs a deliberate decision and a composite key, not a silent
-- default.
--
-- tenant_id stays as a nullable record of WHO the person was talking to when they opted out. It is
-- provenance, not a scope.
--
-- Idempotent.

ALTER TABLE email_suppressions
  ADD COLUMN IF NOT EXISTS detail        text,
  ADD COLUMN IF NOT EXISTS suppressed_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE email_suppressions ALTER COLUMN tenant_id DROP NOT NULL;

-- Replace the composite uniqueness with uniqueness on the address itself.
ALTER TABLE email_suppressions DROP CONSTRAINT IF EXISTS email_suppressions_tenant_id_email_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_suppressions_email_key'
  ) THEN
    ALTER TABLE email_suppressions ADD CONSTRAINT email_suppressions_email_key UNIQUE (email);
  END IF;
END $$;

COMMENT ON TABLE email_suppressions IS
  'Opt-outs, keyed by EMAIL ADDRESS and global across tenants. Suppression is a STATE, not a deletion — deleting the contact means the next list import resurrects them.';
