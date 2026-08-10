-- Flow 16 — "build the quote or proposal" — needs to know what a quote LOOKS LIKE for this business.
--
-- When the owner says "quote Trinh for the platform work", the useful answer is not a generic quote.
-- It is a quote in HIS format, because the last twenty Factory2Key quotes are the only thing that
-- knows what that is. Everything else the drafter produces is a plausible quote from no particular
-- business.
--
-- WHY A TABLE RATHER THAN AN AGENT THAT RE-READS DRIVE EACH TIME.
--
-- The format is an authoritative, slow-moving fact ABOUT the business — DATA_STANDARD D1 puts that in
-- a structured table, not in a model's context window on every request. Re-deriving it per quote
-- would cost a Drive round trip plus an extraction call each time, and would let the same business
-- get a different format on Tuesday than it got on Monday, from the same documents. A quote format
-- that is not stable is not a format.
--
-- So: extract ONCE (or when the owner asks again), store, version. The agent that writes the quote
-- starts warm on knowledge without anything being warm.
--
-- WHAT IS DELIBERATELY NOT STORED: the quote documents themselves. We keep the SHAPE — sections,
-- ordering, how they express price, their sign-off — plus a short excerpt as evidence. Copying a
-- business's document store into ours is exactly what "we own our own records completely, and nobody
-- else's business records at all" forbids, and it would make us a second source of truth for a
-- record Drive already owns.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS quote_formats (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Bumped on every re-extraction rather than overwritten. A format that changes is a fact about the
  -- business worth being able to look back at — and if a new extraction is worse than the old one,
  -- the previous version is still there to fall back to rather than lost to an UPDATE.
  version       integer NOT NULL DEFAULT 1,

  -- The shape itself: ordered sections, how they express price, tax treatment, sign-off, tone.
  -- jsonb rather than columns because this is a description of someone's document, and the next
  -- business's will have a section ours does not.
  structure     jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- WHERE IT CAME FROM. A format with no provenance cannot be checked by the owner, and the whole
  -- point is that he can say "no, that's the old template" — DATA_STANDARD I3.
  source_files  jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{id, name, modifiedTime}]
  sample_excerpt text,                                 -- a short quotation, as evidence. NOT the document.

  -- Confirmed by a human, or merely extracted? An unconfirmed format is usable; it is just not
  -- something to state to the owner as though he had agreed it.
  confirmed_at  timestamptz,
  confirmed_by  text,

  extracted_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, version)
);

ALTER TABLE quote_formats ENABLE ROW LEVEL SECURITY;

-- The current format for a tenant is the highest version. Indexed descending so "give me the current
-- one" is the cheap query, because it is the one every quote makes.
CREATE INDEX IF NOT EXISTS quote_formats_current_idx
  ON quote_formats (tenant_id, version DESC);

COMMENT ON TABLE quote_formats IS
  'How THIS business writes a quote, extracted from their own past quotes in Drive. A standing fact, versioned, with provenance — not re-derived per quote.';
COMMENT ON COLUMN quote_formats.structure IS
  'Ordered sections, price expression, tax treatment, sign-off, tone. Shape only — never the documents themselves.';
COMMENT ON COLUMN quote_formats.confirmed_at IS
  'Set when a human agreed this is right. Unconfirmed formats are still used; they are just not asserted to the owner as agreed.';
