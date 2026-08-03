-- 007 — the address a tenant's mail is SENT FROM.
--
-- Until now `from` came from one environment variable, so every tenant's mail left on the same
-- address regardless of whose business it was. The identification footer was already correct — it
-- carries the tenant's legal name and ABN — so this was never a Spam Act failure. It was a trust
-- failure, and it has a real example: a construction client receives Factory2Key's quote from
-- noreply@updates.corporateaisolutions.com, an AI company they have never heard of, on the one
-- document where the sender's identity is the whole point.
--
-- NULL IS A LEGITIMATE STATE, and this is the deliberate part. A tenant with no verified sending
-- domain of its own falls back to the portfolio address rather than being refused: the footer is
-- still lawful, and refusing would stop every tenant that has not yet done DNS — which today is all
-- of them. The fallback is REPORTED rather than silent (see DrainReport.usedFallbackFrom), because
-- the failure mode worth preventing is not the fallback itself but nobody knowing it happened.
--
-- It must be a full RFC 5322 address ("Factory2Key <noreply@updates.factory2key.com.au>" or the
-- bare address), on a domain verified in Resend. An unverified domain is rejected at send time, and
-- the error surfaces the provider's own words rather than a generic failure.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS from_email text;

COMMENT ON COLUMN tenants.from_email IS
  'Verified sending address for this tenant''s own domain. NULL = fall back to the portfolio '
  'default (EMAIL_FROM). Set only once the domain is verified in Resend, or sends will be rejected.';
