# The system-of-record port — where the Genome lands, without picking a vendor

> **Status:** design, agreed 2026-08-05. Companion doc in Kira: `docs/GENOME_WRITE_BACK.md`.
> The orchestrator owns this half because it owns the credentials.

## Why this exists

Kira's job is a **migration**: knowledge out of the owner's head and into the business's own systems.
Extraction alone adds nothing to a buyer or a seller — the value appears when it lands somewhere the
business keeps, and survives us. Today every path terminates in our database: Drive is read/search
only, and `keep_document` files into *ElevenLabs'* knowledge base, not the owner's Drive.

So there is no write path at all. This is the plan for one.

## The constraint that shapes it

**No vendor lock — ours or the customer's.** The Kira/orchestrator split is the precedent: Kira holds
no Google credentials and cannot; it asks over HTTP and this side decides how. The same seam applies
to the destination.

**Kira must never know where the manual went.** It renders documents and says "file these". The
orchestrator resolves the tenant's connected destination and does it. That is what makes the vendor
swappable — not a config flag, but the fact that the calling side has no opinion to change.

Two things follow that are easy to get wrong:

1. **The floor adapter is built FIRST, and it needs no vendor at all.** An owner must always be able
   to take the whole manual as files, with no account anywhere. That single guarantee is what makes
   "you are not locked in" a true statement rather than a reassurance — and it is the thing a buyer's
   advisor actually needs, because he will not be given a login to anything.
2. **Capability, not assumption.** Adapters differ in what they can do (rich text, update-in-place,
   sharing, folders). The port declares capabilities and the caller degrades honestly — never assumes
   a destination can update and silently duplicates when it cannot.

## The port

```ts
export interface RecordDestination {
  readonly kind: 'drive' | 'onedrive' | 'push-api' | 'download';
  capabilities(): { update: boolean; richText: boolean; folders: boolean; share: boolean };

  /** Find-or-create the container. Idempotent on name within the tenant. */
  ensureContainer(tenantId: string, name: string): Promise<{ containerId: string; url?: string }>;

  /**
   * Create or update ONE document. `existingRef` is the caller's stored handle; when absent this
   * creates. Returns the ref to store. Idempotency lives with the CALLER, deliberately — the
   * destination cannot know that "Cash and invoicing" is the same area it wrote last month.
   */
  putDocument(params: {
    tenantId: string;
    containerId: string;
    title: string;
    html: string;
    existingRef?: string;
  }): Promise<{ ref: string; url?: string }>;
}
```

That is the whole surface. Everything else is an adapter concern.

## Adapters, in build order

| # | Adapter | Why this order | Status |
|---|---|---|---|
| 1 | **`download`** | No account, no vendor. The anti-lock guarantee and the only one that can never break. Built first so the promise is true from day one. | ✅ **built — but NOT behind this port. See below.** |
| 2 | **`drive`** | The one live connection uses it, and the scopes are already there. | ✅ `ensureFolder` + `upsertDoc` (2026-08-05) |
| 3 | **`onedrive`/SharePoint** | Probably the bigger SME reality — a lot of trade businesses are on Microsoft 365, not Google. Currently unbuilt anywhere (Kira register B17 notes the gap). | — |
| 4 | **`push-api`** | For a customer who already runs an enterprise knowledge layer. See below. | — |

### ⚠️ Amendment (2026-08-05): `download` lives in KIRA, not behind this port

Written into the plan as adapter 1 here, and built somewhere else. Recording the correction rather
than letting the doc quietly diverge from the code, because a design doc nobody trusts is worse than
none.

**Why the change:** the port exists to hold *credentials* the calling side must not have. A download
involves none — Kira has already rendered the bytes, and routing them out to the orchestrator so
they can come back and be streamed to the browser is a hop that buys nothing and adds a failure
mode. It ships as `GET /api/genome/manual?audience=owner|buyer` in Kira.

**What that costs, stated honestly:** Kira now knows about exactly one destination, so the "the
caller has no opinion about the vendor" property is not quite absolute. It is bounded and it is the
right trade — the one destination Kira knows is the one that *is* no vendor.

**The rule this leaves:** anything needing a token goes behind the port. Anything needing nothing
does not.

## On Glean and its kind

Glean is an enterprise play — permission graphs, MDM, IT and finance as buyer — and almost none of
this ICP will ever have it. It is **not** an integration target to build for. But two things on their
own pages are the right *shape* to design against, because they are becoming standard:

- **Push API** — the generic "here is content, index it" surface.
- **MCP connectors** — increasingly how any agent platform ingests a source.

So adapter 4 is `push-api` **generically**, with Glean as one possible configuration, not a
first-class integration. If an SME-focused equivalent emerges, it is a config, not a project.

**The other direction matters more.** Exposing the Genome as an **MCP server** makes it readable by
Glean, Claude, ChatGPT and whatever replaces them — vendor-neutral by construction, and a source none
of them can generate for themselves, since it never existed in a document to be indexed.
`@caistech/webmcp-kit` and `PRODUCT_STANDARDS` §11 Layer 3 already point there.

## What has to change here

1. ~~**`src/connectors/google.ts`** — add `ensureFolder` and `upsertDoc`.~~ ✅ **Done 2026-08-05.**
   The file's own warning applied in reverse: native Docs have no bytes to download and must be
   **exported** to read; to write, upload HTML and let Drive convert. Markdown does not convert; a
   PDF leaves an owner a document he cannot edit, which stops being current the day it is written.
   `ensureFolder` finds before it creates — Drive keys on id, not name, so create-first accumulates
   one folder per run. `upsertDoc` treats a 404/403 on the stored id as "he deleted it, write it
   again" rather than as a failure. `driveQuoted` escapes the query string, because "O'Brien
   Plumbing" is not an exotic trading name.
2. **`src/record/`** — the port and the registry. (`download` is NOT here — see the amendment above.)
3. **`app/api/v1/tenants/[tenantId]/record/`** — one endpoint, same shared-secret auth as `lookup`.
   **This is the remaining gap: the write functions exist and nothing can call them yet.**
4. ~~**The default Drive access — change `readonly` → `picked` before a second owner connects.**~~
   ✅ **Done 2026-08-05**, while exactly one owner was connected (on `full`, so unaffected). Both
   sites moved — the consent route's `DEFAULT_DRIVE_ACCESS` and the callback's own fallback, which
   must agree or the label shown to the owner describes a different access level from the one he was
   sent to grant. What was GRANTED is still read back from the token response, never assumed.

## Verified facts this rests on (2026-08-05, not assumed)

- **One Google connection exists**, `dennis@factory2key.com.au`, scope `full` → **write already
  permitted, no re-consent for the only connected owner.**
- **The refresh path works on an expired token.** Probed through production Kira: `expires_at` was
  `2026-08-04T08:15` (expired), `search_drive` returned 8 real files, `expires_at` moved to
  `2026-08-04T21:39`, `last_error` null. So the write-back will not fail on expiry — which would have
  looked like a build defect while being an auth problem.
- **`tenant_id` IS the Kira app user id** — `7f1c4e2f-0ada-48a5-92f7-946ae9b92a4a`, confirmed in full
  rather than inferred from a matching prefix. The write path keys on this.
- **Three Supabase instances are in play**: Kira `kmrskyewwnwettlycpfe`, orchestrator
  `xuzvurmprexhalnxgsdu`, and the cockpit's. Say which, in every migration.

## One process note, from getting it wrong today

A probe script selected a column that does not exist; PostgREST failed the whole select and returned
`data: null`, and the script discarded the error. It read exactly like "there is no connection". Any
script here **prints the error**, never just the data — the failures that cost the most this week
were all checks that reported nothing and were read as reporting absence.
