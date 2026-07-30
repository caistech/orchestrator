-- The Google Drive connector needs one thing the Xero flow did not: state that survives the round
-- trip to Google.
--
-- The owner chooses their access level (full / read-only / only-files-you-pick) and names the Google
-- account BEFORE they leave for the consent screen, and the callback has to know both — which access
-- level was asked for, so a silently narrowed grant is detectable, and which address they said they
-- would use, so connecting the WRONG Google account is visible rather than a Drive that mysteriously
-- has none of their documents in it.
--
-- Carried in the state row rather than the redirect URI, because anything in the URI is attacker-
-- controlled by the time it comes back. The state row is ours, written before the redirect, read
-- once after it.
--
-- Idempotent.

ALTER TABLE oauth_states
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN oauth_states.metadata IS
  'What the owner chose before the redirect: requested access level, the Google address they named, and where to return them. Read once in the callback.';

-- An unconsumed state is a replayable ticket. They are single-use by the callback''s conditional
-- update, but a stale row should not linger either; this index makes the cleanup sweep cheap.
CREATE INDEX IF NOT EXISTS oauth_states_unconsumed_idx
  ON oauth_states (created_at) WHERE consumed_at IS NULL;
