# Orchestrator — Low-Level Design (as built)

**As at 2026-08-11.** Module-by-module detail behind `docs/HLD.md`. Read the HLD first for the shape;
this document is for changing the thing. It ends with **§7, three recipes**: how to add a rule, a
connection, and a tool.

Statuses used throughout: **Live** (proven against a real business) · **Built** (written and
exercised) · **Proposed** (designed here, no code).

---

## 1. Module map

| File | Lines | Responsibility | Notes that matter when editing |
|---|---:|---|---|
| `src/contract.ts` | 196 | **The seam.** Versioned wire types. | Nothing else crosses between caller and orchestrator. A change here is a contract change — bump `CONTRACT_VERSION`. |
| `src/caller-auth.ts` | 168 | Who is calling; which tenants they may act for. | Reads two env vars via `CallerEnv`. Unknown caller → 401; wrong tenant → 403; no registry → **503, never open**. |
| `src/sweeper.ts` | 268 | `sweep → threshold → confirm → compose → gate → emit` | The only writer of `tasks` in the STA path. Idempotent per (flow, entity, day). |
| `src/rules.ts` | 216 | The flows, as data. 7 of ~20. | Adding the 21st flow must not mean writing a 21st function. |
| `src/gate.ts` | 79 | Bands resolve from the **action**, never the flow. | `reserved` is checked first and unconditionally. **Unknown actions hold.** |
| `src/drafter.ts` | 177 | The one agent: classify, then draft. | Never sends. Refuses to invent a recipient. |
| `src/tools/register.ts` | 120 | **The tool register** — loads and validates `config/tools.json`. | Validation throws; a quietly-skipped bad entry is the failure being prevented. |
| `src/tools/executors.ts` | 105 | `kind → executor`, a **static** map. | Static because a dynamic import by string path is not bundled and fails in prod, not CI. |
| `src/knowledge/quote-format.ts` | 300 | **Flow 16** — learn / store / read how this business writes a quote. | Five distinct failure reasons, not one shrug: each maps to a different fix. Versioned on save, never updated. |
| `src/knowledge/past-pricing.ts` | 145 | **Flow 13** — what did we charge for similar work? | The refusal instruction ships WITH the figures, never in the drafter, so figures cannot reach a prompt without it. Returns [] on every failure — a quote must not fail to draft because history was unavailable. |
| `src/confirm.ts` | 65 | Source-of-record confirmation. | Unreachable ≠ contradicted: one goes to review, the other is dropped. |
| `src/callback.ts` | 53 | The return leg to the caller. | Fail-soft: the mail has already left, so a down caller must not make a good send look failed. |
| `src/connect-token.ts` | 65 | HMAC ticket so a caller can start a consent flow. | The tenant is a **claim**, not a query parameter. |
| `src/jurisdiction.ts` | 132 | AU-only commercial mail. | 18 tests in `jurisdiction.test.ts`. Commercial guarded, transactional deliberately not. |
| `src/connectors/email.ts` | 290 | claim → send → record. | Sends as the **tenant's** identity. Throws when identity is incomplete. |
| `src/connectors/email-render.ts` | 158 | Text → HTML. | Blank lines become paragraphs, `- ` lines become lists. |
| `src/connectors/xero.ts` | 241 | OAuth, sync, **and `XeroSourceConfirmer`**. | Refresh tokens **rotate per use** — persist in the same statement or lose the connection. |
| `src/connectors/xero-read.ts` | 206 | Generic resource read (`readXero`, `XERO_RESOURCES`). | Consumed by `/v1/read`; borrows `accessTokenFor` from `xero.ts`. Distinct from the confirmer above — this is the caller-facing read, that is the pre-emit check. |
| `src/connectors/google.ts` | 437 | Drive OAuth + read + write. | Three traps documented in-file: refresh token returned once; scopes can be unticked; native Docs need export, not download. |
| `src/connectors/google-contacts.ts` | 290 | Contact lookup. | Requested with Drive to avoid a second consent trip. |

**Routes.** `/api/v1/`: `dispatch`, `read`, `tasks`, `tasks/[id]`, `tasks/[id]/approve`,
`tenants/[tenantId]/{connections,identity,lookup,record}`. `/api/connect/`: `google`,
`google/callback`, `xero`, `xero/callback`. `/api/cron/`: `sweep` (hourly), `drain` (15 min).
`/api/auth/`: `callback`, `signout`. **Pages:** `/queue`, `/tasks`, `/connections`, `/settings`,
`/login`, `/no-access`, `/unsubscribe`.

---

## 2. Runtime paths

### 2.1 The sweep path (STA — the twenty threshold flows)

```
cron/sweep (hourly)
  └─ for each RULE in src/rules.ts
       ├─ SELECT entities WHERE tenant + kind + thresholds        ← the projection finds CANDIDATES
       ├─ if rule.confirmAtSource && row.mode = 'projected'
       │    └─ confirmer.confirm(row)                             ← the SOURCE makes the DECISION
       │         ├─ contradicted → drop  (correct; needs no human)
       │         └─ unreachable  → unroutable_requests + review
       ├─ compose  = rule.template(row)
       ├─ gate     = resolveBand(policy, {flow, action, spend})   ← from the ACTION
       └─ emit
            ├─ tasks (status: awaiting_approval | queued)         ← unique on intent_id
            ├─ drafts
            ├─ task_events 'routed'
            └─ holds ? approvals : effects{kind:'email.send'}     ← the outbox
```

The idempotency key is `(flow, entity, day)`. A duplicate insert returns `23505` and is counted as a
duplicate, **not** an error — that conflict is the key doing its job, and treating it as a failure
would be a reason to send a second chase.

`commercial` travels **on the effect**, not re-derived at send time. The connector must not have to
look up which rule produced a row to know whether the Spam Act applies; that lookup is the kind that
gets dropped in a refactor.

### 2.2 The dispatch path (SAY — a person spoke)

```
POST /v1/dispatch  (x-orchestrator-secret)
  ├─ authoriseCaller(request, body.tenantId)     401 / 403 / 400-blank-tenant / 503-unconfigured
  ├─ idempotency on intentId
  ├─ classifyIntent()        → quote | email | reminder | unsupported
  │    └─ unsupported → unroutable_requests, status 'unsupported'   (captured, never dropped)
  ├─ draftForIntent()        → {summary, preview}
  └─ tasks + drafts, status awaiting_approval        ← NEVER sends
```

Then `POST /v1/tasks/:id/approve` inserts the `effects` row. **The drafter cannot emit an effect; the
approve route can.** That is the read/effect split at its narrowest point.

Two refusals worth knowing before you touch `drafter.ts`, both from real incidents:

- A **spelled-aloud address** (`m-c-m-d-e-n-n-i-s@gmail.com`) is refused, not repaired. Reassembling
  it is a guess about what someone said out loud, and the cost of being wrong is a quote landing at a
  stranger's address. Returning null routes into the ask-the-owner path, which is cheap.
- The `preview` is sent **verbatim**, so the prompt forbids placeholders. `Thanks, [Owner's Name]`
  reached a real client exactly once.

### 2.3 The drain path (register-driven since 2026-08-11)

```
cron/drain (15 min, Bearer CRON_SECRET)
  ├─ SELECT effects → tasks(tenant_id) WHERE status='pending'          ← EVERY kind, deliberately
  ├─ partition by executableKinds() from the tool register
  │    ├─ registered   → group by (kind, tenant)
  │    └─ unregistered → count per kind, console.error, and REPORT at the top level
  ├─ for each (kind, tenant), bounded to 50 tenants/run
  │    └─ executorFor(kind)  in its own try/catch
  │         ├─ result.skipped → SKIP with a reason (routine, not an incident)
  │         └─ any throw      → error, stops at THAT tenant
  └─ report {pendingEffects, kindsRun, sent, failed, refused, skipped, errors,
             truncated, unregistered?, tenants[]}
```

Selecting every kind and filtering in code is the deliberate choice: filtering in the query would
reproduce the original defect in a new place, because the rows it cannot execute are exactly the rows
worth knowing about.

Per-tenant isolation is load-bearing: one un-onboarded business used to abort the batch, so nobody
else's mail went either. Truncation is logged rather than silent — a bound that truncates quietly
reads as "everything was covered".

### 2.4 The connect path

```
Kira renders a setup page
  └─ signConnectToken({tenantId, access, email, returnTo, exp})       HMAC, ~1h
       └─ browser → /api/connect/google?token=…
            ├─ verifyConnectToken()        null on ANY failure — shape, signature, expiry
            ├─ oauth_states row            short-lived, single-use
            └─ redirect to Google (prompt=consent, so a refresh token is actually returned)
                 └─ /api/connect/google/callback
                      ├─ exchange code
                      ├─ read back the GRANTED scope — asking for Drive is not receiving it
                      └─ upsert connections (never null over a live refresh_token)
```

`/api/*` is outside the auth middleware — it must be, or this redirect would be swallowed — so the
tenant arrives as a signed claim rather than a query parameter. Otherwise an unauthenticated stranger
could start a consent flow naming somebody else's tenant and attach their own Google account to it.

---

## 3. Data model (13 tables)

| Table | Owns | Key columns |
|---|---|---|
| `tenants` | the business | `name`, `timezone` (IANA, never an offset) |
| `entities` | **the projection** | `kind`, `mode` (projected\|authoritative), `source_system`/`source_id`, `days_overdue`, `last_contacted_at`, `expires_on`, `attributes` jsonb |
| `entity_aliases` | name resolution | `alias` |
| `tasks` | **ours** | `intent_id` (idempotency), `flow`, `ingress`, `tier`, `status`, `subject_entity_id`, `payload` |
| `task_events` | audit | `event`, `detail`, `correlation_id` |
| `effects` | **the outbox** | `kind`, `connector`, `idempotency_key` UNIQUE, `request`, `status`, `attempts` |
| `drafts` | what a human approves | `channel`, `subject`, `body`, `recipients` |
| `approvals` | the decision | `decided_by`, `decision`, `reason` |
| `delegation_policy` | **the gate, as data** | `bands` jsonb, `reserved` jsonb, `version` |
| `unroutable_requests` | what nothing could route | `raw`, `reason` — the agent-builder backlog |
| `connections` | **OAuth grants** | `provider`, `provider_org_id`, tokens, `scopes`, `revoked_at` |
| `oauth_states` | consent in flight | `state` PK, `consumed_at` |
| `email_suppressions` | opt-outs | keyed by **email**, not user id |

RLS is on for every table, service-role only. `connections` has **no policies at all** — there is no
reason for a browser to hold a refresh token. `revoked_at` rather than `DELETE`, because "we no
longer have access to their Xero" is an operational fact, and a deleted row reads identically to a
tenant who never connected.

The three status columns are constrained enums; `entities.kind` and `effects.kind` are deliberately
**open text**, because vertical packs add kinds. §6.2 is about the consequence of that for `effects`.

---

## 4. What is already config, and how it works

### 4.1 Sweep rules — `src/rules.ts`

A `SweepRule` is `{flow, name, entityKind, thresholds[], action, spendAttribute?, confirmAtSource,
commercial, template}`. The predicate language is four shapes only — `atLeast`, `below`, `olderThan`,
`within`, plus `jsonBelow` for attribute comparisons. That smallness is a decision: a general
expression language here would be a small database engine nobody asked for, and it would move the
logic out of a reader's reach.

Note the upper bound in flow 45 (`below days_overdue 60`). Without it every 67-day invoice fires both
45 and 46, and the client gets a polite reminder and a final notice in the same run.

### 4.2 Delegation bands — the `delegation_policy` table

```jsonc
{
  "bands": {
    "notify":               { "actions": ["…"] },
    "approve_before_send":  { "actions": ["…"] },
    "approve_before_start": { "actions": ["…"], "spend_threshold_aud": 5000 }
  },
  "reserved": ["76","81","80","134","112","100"]
}
```

Resolution order is `reserved` → spend → send → notify → **hold**. Spend gates before send because
money leaving is the higher consequence and an action can be both. A tenant with no row holds
everything, which is currently the only thing standing between a real ledger and outbound mail.

### 4.3 Callers — `ORCHESTRATOR_CALLERS`

```json
[{ "id": "f2k", "secret": "…", "tenants": ["<uuid>", "<uuid>"] }]
```

`tenants: "*"` is a wildcard. `ORCHESTRATOR_SECRET` still registers as a wildcard caller named
`legacy`, kept because Kira is live on it. Malformed JSON **throws** rather than yielding an empty
registry: an empty registry refuses everything, which looks like an outage and reads as safe — but
the operator's next move is to set the legacy secret and carry on, quietly reinstating the wildcard
this exists to remove.

---

## 5. What is NOT config yet

### 5.1 Connections

Adding a provider today touches: `app/api/connect/<p>/route.ts`, `app/api/connect/<p>/callback/route.ts`,
`src/connectors/<p>.ts`, and a hardcoded `<a href="/api/connect/xero">Connect Xero →</a>` in
`app/connections/page.tsx`. Four files and a deploy, and the UI edit is the one that gets forgotten —
a provider can be fully wired and invisible.

### 5.2 Effect executors — CLOSED 2026-08-11, see §6.2

Until the tool register was built, `app/api/cron/drain/route.ts` queried `.eq('kind', 'email.send')`
and called one function, while `effects.kind` documented `invoice.create | calendar.book | …` as
intended values. **An effect of any other kind was accepted, stored, and never executed** — no error,
no retry, no alert, `status` stuck at `pending` while every screen looked healthy. The same
silent-failure shape that has already cost this repo twice: a hardcoded tenant constant that held
four approved emails (including a $60,000 quote) for three days, and a month of failed deploys nobody
saw because production kept serving.

The drain no longer names a kind. §6.2 is what replaced it.

---

## 6. The registries

**§6.2 tool register: Built.** **§6.1 connector manifest: Proposed, no code.** Both mirror the three
registries in §4 that already work.

### 6.1 Connector manifest

`config/connectors/<provider>.json`, loaded at boot into a `CONNECTORS` map:

```jsonc
{
  "provider": "myob",
  "label": "MYOB",
  "kind": "accounting",
  "auth": {
    "type": "oauth2",
    "authUrl": "https://secure.myob.com/oauth2/account/authorize",
    "tokenUrl": "https://secure.myob.com/oauth2/v1/authorize",
    "clientIdEnv": "MYOB_CLIENT_ID",
    "clientSecretEnv": "MYOB_CLIENT_SECRET",
    "redirectPath": "/api/connect/myob/callback",
    "refreshRotates": true,          // Xero true, Google false — decides the persist-or-die rule
    "promptConsent": false,          // Google needs true or no refresh token comes back
    "readBackGrantedScopes": true
  },
  "accessLevels": {                  // what the OWNER chooses; least privilege first
    "readonly": { "scopes": ["…"], "default": true },
    "full":     { "scopes": ["…"], "warn": "restricted scope — triggers vendor verification" }
  },
  "capabilities": ["entities.sync", "source.confirm"],
  "adapterModule": "src/connectors/myob.ts",
  "flowsUnlocked": ["45", "46", "107"]
}
```

Consumed by **one** generic route pair (`/api/connect/[provider]` + `/callback`) that does the parts
that are identical everywhere: verify the connect token, mint and consume `oauth_states`, build the
authorise URL, exchange the code, read back granted scopes, upsert `connections`. The
`/connections` page renders every registered provider, so wiring one cannot leave it invisible.

**What stays code, deliberately:** `adapterModule` — parsing that vendor's records into `entities`,
and its confirmer. Every real trap in `google.ts` and `xero.ts` lives in exactly that layer (native
Docs need export not download; Xero's refresh rotates per use), and a config file that claimed to
abstract them would be lying about the hardest part.

### 6.2 Tool register — **Built**

The `tool_register` from `EXECUTION_LAYER.md` §16.2, made executable. Three parts:

| Part | File | Holds |
|---|---|---|
| The facts | `config/tools.json` | one entry per kind — class, connector, requirements, retries, flows unlocked |
| The binding | `src/tools/executors.ts` | `kind → executor function`, a static map |
| The loader | `src/tools/register.ts` | validate, `executableKinds()`, `isExecutable()` |

```jsonc
{
  "kind": "email.send",              // matches effects.kind EXACTLY
  "class": "effect",                 // "read" | "effect" — the safety split, declared
  "label": "Send an email",
  "connector": "resend",
  "requiresConnection": false,
  "requiresSenderIdentity": true,
  "idempotent": true,
  "maxAttempts": 3,
  "flowsUnlocked": ["9","19","45","46","56","67","127"]
}
```

The drain is now: *select **all** pending effects, run the kinds the register covers, report the ones
it does not.* One loop instead of one hardcoded kind.

**Two departures from the design as first written in this document, both forced by reality:**

- **One file, not one per tool.** A serverless bundle cannot glob a directory at runtime, so per-kind
  files would need an index someone must remember to update — the same forgettable step that leaves
  a connector wired and invisible in the connections UI. One file has no index to forget.
- **No `executorModule` string.** The original schema named the executor by path and imported it
  dynamically. That does not survive bundling: a path that exists only as a string is not bundled,
  so the tool fails in production with module-not-found rather than in CI. A registry whose failure
  mode is *"works locally, missing in prod"* is worse than the hardcoded call it replaced. The
  binding is therefore code, and `npm run check:tools` asserts the two halves agree — which converts
  the one real risk of splitting them into a build failure.

**Three non-negotiables, each a lesson rather than a preference — all three now enforced:**

1. **An unregistered kind is LOUD.** The drain deliberately selects pending effects of *every* kind,
   because filtering in the query would reproduce the original defect in a new place: the rows it
   cannot execute are exactly the rows worth knowing about. Unknown kinds are counted per kind,
   `console.error`'d with the fix, and returned at the top level of the cron response as
   `unregistered: [{kind, pending}]`.
2. **`class: "effect"` never places a tool in a handler's tool set.** Registration makes a tool
   executable *by the drain*, and by nothing that reasons. `isExecutable()` returns false for a read
   tool even though it is registered, and `check:tools` asserts a read tool is neither executable nor
   bound — mutation-verified.
3. **A missing prerequisite is a SKIP with a reason, not an error.** A tenant part-way through
   onboarding is an expected state; reporting it as a failure trains everyone to ignore the log.
   `ExecutorResult.skipped` is first-class, and the email executor uses it for both an absent sender
   identity and an unset API key.

**What `check:tools` asserts** (`scripts/check-tool-register.ts`, in CI):

- the register parses — validation **throws** rather than filtering, because a quietly-skipped
  malformed entry produces the exact failure the register exists to end;
- every `class:effect` entry has an executor bound, and every bound executor is registered;
- no read tool is executable or bound;
- **every effect kind the source can emit is registered** — a literal-only scan of `.from('effects')`
  inserts. A computed kind is invisible to it, which is stated rather than hidden: it is a floor, not
  a proof, and it catches the realistic mistake of adding a second emit site and forgetting the
  register. This is the assertion that *prevents* a stuck row rather than reporting one.

Mutation-verified: renaming the kind in the config turns 3 checks red; downgrading `effect` to `read`
turns 3 red including the boundary assertion. Restoring returns green.

### 6.3 Sequencing — where this got to

1. ~~Tool register~~ — **done 2026-08-11.**
2. **Move the Drive write path onto it** as effect kind `document.write` (HLD §8). Not done: it is a
   behaviour change to a live endpoint, not a refactor, and belongs in its own change.
3. **Connector manifest** when the third provider arrives. Two providers do not prove an abstraction,
   and generalising from two is how you get a config format that fits neither.

---

## 7. Recipes

### 7.1 Add a sweep rule (flow)

1. Append a `SweepRule` to `RULES` in `src/rules.ts`.
2. Confirm the `entityKind` is actually fed by a connector — a rule for an entity kind nothing
   populates is a roadmap pretending to be a capability.
3. Set `confirmAtSource: true` unless we are canonical for that record.
4. Set `commercial` as a **legal** classification, not a tone one. Marking everything commercial is
   not the safe option — it puts an unsubscribe link on a debt notice.
5. Band the new `action` in each tenant's `delegation_policy`, or it will hold by default (correct,
   but it will look broken).
6. `npm run sweep -- --tenant <uuid> --dry-run` — always, before any tenant with real data.

### 7.2 Add a connection (today, pre-registry)

1. `src/connectors/<p>.ts` — authorise URL, token exchange, refresh, read-back of granted scopes.
2. `app/api/connect/<p>/route.ts` — verify the connect token, mint `oauth_states`, redirect.
3. `app/api/connect/<p>/callback/route.ts` — consume state, exchange, upsert `connections`.
4. **Add it to `app/connections/page.tsx`.** Skipping this leaves it wired and unreachable.
5. Decide `refreshRotates` and write the new refresh token *in the same statement* as the access
   token if it does.
6. Never let a re-auth write `null` over a live `refresh_token`.

### 7.3 Add a tool

1. **Register it** — one entry in `config/tools.json`. `kind` must match `effects.kind` exactly.
2. **Bind it** — write the executor and add it to `EXECUTORS` in `src/tools/executors.ts`. It takes
   an `ExecutorContext` and returns `{sent, failed, refused, skipped?, reason?}`. Claiming rows is
   the executor's own job — never hand it pre-claimed rows, or two executors race over one outbox.
3. **`npm run check:tools`.** It fails if the two disagree, so you cannot ship half of it.
4. Emit the effect only from a path that has passed the gate — the approve route or the sweeper's
   notify band. **Never from a handler.**
5. Give it an `idempotency_key` stable for the *trigger*, not the attempt.

`app/api/cron/drain/route.ts` is **not** edited. That is the point of the register: the step that
used to be forgettable, and silent when forgotten, no longer exists.

A **read** tool is registered the same way with `class: "read"` and no executor. It stays unreachable
from the outbox by construction.

---

## 8. Security invariants

Each is currently true; each is worth a test before it is trusted:

| Invariant | Where |
|---|---|
| No caller registry configured → **503**, never open | `caller-auth.ts` |
| Malformed registry → throw, never an empty (permissive-by-restart) registry | `parseCallers` |
| Absent or blank `tenantId` → **400**, never an implicit default | `authoriseCaller` |
| A scoped caller cannot act for another tenant → **403** | `authoriseCaller` |
| Secret comparison is length-independent | `secretsMatch` |
| Inbound and callback secrets are **different values** | `contract.ts` |
| The tenant on a consent flow is a signed claim, not a parameter | `connect-token.ts` |
| Unknown gate action **holds** | `gate.ts` |
| `reserved` is checked first and cannot be undercut | `gate.ts` |
| Commercial mail to a non-AU recipient throws | `jurisdiction.ts` |
| Sends carry the **tenant's** ABN, never ours | `connectors/email.ts` |
| `connections` has RLS on and no policies | `db/005` |

Covered by `npm run check:auth` (12 assertions) and `npm test` (18 tests). The rest are asserted by
reading, which is weaker — the gate and jurisdiction invariants are the obvious next tests.

---

## 9. Verification surface

| Command | What it proves |
|---|---|
| `npm run typecheck` | compiles |
| `npm test` | 18 jurisdiction tests |
| `npm run check:auth` | 12 caller/tenant boundary assertions |
| `npm run check:tools` | the register and its executors agree; no read tool is executable; every emitted kind is registered |
| `npm run build` | the production build Vercel runs |
| `npm run db:migrate -- --ref <ref> --expect "<name>"` | what schema WOULD be applied; refuses a project whose name is not the expected one |
| `npm run db:seed -- … --apply` | the fixtures, as a separate verb — the seed DELETEs and re-INSERTs |
| `npm run probe:pricing` | flow 13's query against a live database: returns rows, filters, escapes LIKE |
| `npm run sweep -- --tenant <uuid> --dry-run` | what *would* be decided, writing nothing |
| `npm run drain -- --dry-run` | what *would* be sent |
| `npm run drain -- --redirect you@real.com` | a real send, to yourself |
| `npm run xero:sync` | pulls invoices into `entities` |
| `npm run learn:quotes -- --tenant <uuid> --dry-run` | what format WOULD be extracted from their Drive |
| `npm run learn:quotes -- --tenant <uuid> --show` | the stored format, as the drafter sees it |

CI runs the first four on every PR, every push to main, and daily, then asserts production is serving
the expected commit. See `.github/workflows/gate.yml`.
