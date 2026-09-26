# Bank reconciliation categorisation — scoped as a templated registry flow

> Scoped 2026-09-26, from a real case (Global Buildtech Australia's own 1,274-line Xero backlog) and
> aimed at Kira's BBBO client base generally, not just this one account. **Not built. Scope only —**
> matches the "scope first, build separately" discipline this was requested under.
>
> **Read this against `ORCHESTRATOR_SPEC.md` (§6 tiers, §7 registry/gates, §9 data layer) and
> `TASK_REGISTRY.md` — this document proposes ONE new registry flow inside that existing
> architecture. It does not invent a new mechanism.** Where a design choice below just restates a
> decision the spec already made, it's cited rather than re-argued.

---

## 1. Why this fits Kira's BBBO purpose, not just Dennis's own books

An unreconciled year-plus of bank transactions is the accounting-side twin of the exact problem Kira
exists to fix on the operations side: knowledge that only exists in one person's head (or one
overloaded bookkeeper's queue) instead of a documented, transferable record. A BBBO owner who can't
answer "what's my actual trading position" without a $110/hour phone call to an accountant is the same
owner-dependence pattern the whole product is built around — this is a natural, on-thesis capability
for Kira to offer, not a detour into generic fintech.

## 2. The one design principle that governs everything below

**Xero stays the system of record. We never write to it without a human — specifically the
business's own accountant — confirming first.** This isn't a cautious default bolted on; it's the
architecture's own locked decision restated: *"we do not replace a tool the business already uses. We
integrate with what is there, and we build only where nothing is."* (`ORCHESTRATOR_SPEC.md` §9). The
entity index this flow reads into is **projected**, not authoritative — Xero remains canonical, we
hold a thin pointer-home copy, same as invoices and bills already do.

## 3. What this actually is, in the spec's own vocabulary

A new **registry flow** — `task_type: bank_transaction_categorisation` — sitting at the **global**
registry tier (§7.1's three-level inheritance: global → vertical → tenant), so it's written **once**
and every BBBO client's own Xero connection (already tenant-scoped via the existing `connections`
table) plugs into it automatically. This is exactly what "templated skill" means in this
architecture's terms: one manifest, many tenants, per-tenant gate strictness tunable without touching
the manifest itself.

**Not a sweep-and-chase flow** (the existing 20 §6 flows: threshold → template → send). This is
closer in shape to `read` (§ existing `/v1/read`, `look_up_financials`'s pattern in Kira) plus
`dispatch` (a drafted artefact held for approval) — a **read-and-propose** flow with no outbound
message to a third party at all. The "send" here is internal: a proposal into a review queue.

## 4. Data flow

1. **Detect** — sync unreconciled `BankTransactions` (Xero's `IsReconciled==false` filter) into the
   entity index, same shape as the existing `syncInvoices`/`syncBills` in
   `src/connectors/xero.ts` (same `xeroGet` helper, same `entities` upsert pattern, `kind:
   'bank_transaction'`, `mode: 'projected'`). **This one new read call is the only new Xero API
   surface required** — everything else is proposal logic on top of data already in hand.
2. **Build context, per business** — not per transaction in isolation:
   - The business's own chart of accounts (`/Accounts`).
   - The business's own **historical coding pattern** — how it has actually categorised
     similar-description transactions before (queryable from already-reconciled lines). This is the
     single highest-leverage context: a rule/LLM proposing "this looks like a subscription, code it
     to Software & Subscriptions" is far weaker than "this business has coded 40 prior `RENDER.COM`
     lines to account 6420 with no GST" — the second is what a real bookkeeper would do, and it's
     evidence already sitting in Xero, not invented.
   - Any **distilled** (not raw) business-specific convention already captured in the Business
     Genome/Mnemo — per §9's own retrieval pattern, resolve to the canonical entity/business first,
     then pull context against it; never semantic-search blind.
3. **Propose, never write** — for each unreconciled line: `{ account_code, contact, tax_rate,
   confidence, rationale }`. Nothing is written to Xero at this stage. This mirrors `look_up_financials`'s
   own read/write asymmetry in Kira: *"the worst outcome of a wrong read is an embarrassing number,
   the worst outcome of a wrong write is a client who received something"* — here the "something
   received" is a wrong GST treatment on a lodged return, which is a materially higher-stakes write
   than anything Kira's own dispatch_task currently risks.
4. **Stage a review queue, gated at least `approve_before_send`, likely tighter** — per §7.2's
   delegation-policy bands, this is a `commitment`-class action with real blast radius (ATO
   compliance, not just an awkward email), so it should never resolve to `auto` or `notify` regardless
   of value. The existing policy shape already supports a **named override** for exactly this
   ("`overrides: quote_nonstandard_job: approve_before_send` — always, regardless of value") — add
   `bank_transaction_categorisation` as a permanent override at `approve_before_send` minimum,
   independent of the tenant's general spend-based bands.
5. **Second approver = the accountant, not just the owner.** The delegation policy already has a
   `second_approver` field (`{ else: true, band: approve_before_start, second_approver: owner }`) —
   this flow is the first real use case for a **non-owner** second approver. Needs a small, scoped
   extension: the policy's `second_approver` should be able to name a role (`accountant`) resolved
   per-tenant, not just hardcode `owner`. Small addition, not a redesign.
6. **On confirmation, write** (Phase 2 only — see below) — the accountant's approval is what converts
   an AI proposal into an authoritative fact. Only then does a write reach Xero, and only for the
   specific lines actually approved (never a batch-approve-all shortcut for anything below the
   confidence threshold — see §7 risks).

## 5. Where each piece of data belongs (per `DATA_STANDARD`'s own decider)

- **The reconciled ledger entry itself** — structured, exact, auditable. Lives in Xero, always. We
  never become a second copy of it.
- **The proposal + its rationale, pre-confirmation** — our own operational record (`tasks`,
  `drafts`, `approvals` — already-owned tables per §9: *"we own our own records completely, and
  nobody else's business records at all"*). Not Mnemo, not the Genome — this is exactly the
  operational-task-state category those tables already exist for.
- **The distilled coding convention** ("this business treats Google Cloud charges as R&D, not
  overheads") — this, and only this, is Mnemo/Genome-appropriate: a durable, non-PII, business-level
  pattern. The raw transaction lines that produced it are never themselves stored there.
- **Raw transaction line data reaching an LLM at all** is a real decision, not a default. Recommend:
  keep raw description/amount data server-side, send only what the proposal step needs (description
  text, prior-coding examples, chart of accounts) to whichever model does the categorisation judgment
  — and treat the choice of model/provider for this specifically as a deliberate one given
  `cais-shared-services`'s own posture on financial-data handling, not an inherited default from
  wherever Kira's other tools happen to route today.

## 6. Confidence and blast-radius tiering (reuses, doesn't invent, the gate machinery)

Propose a confidence score per line, and let it feed the **same gate resolution** already described
in §7.2 rather than building a parallel scoring system: a low-confidence proposal and a high-dollar
line should both be able to push a category into a stricter band, exactly the way `value` and
`reversibility` already combine there. A $40 recurring SaaS charge matched against 40 prior identical
codings is a very different review-queue item than a $3,600 one-off transfer with no prior pattern —
the second deserves to surface first and be reviewed more carefully, not be buried in a flat list of
1,274.

## 7. Phasing

**Phase 1 (buildable now, low risk): read + propose + stage, zero Xero writes.** Output is a review
queue an accountant can work through — genuinely useful even with no write-back at all, since it
turns "manually categorise 1,274 lines from scratch" into "confirm or correct 1,274 pre-filled
suggestions," which is the real time saving regardless of whether the write itself is automated.

**Phase 2 (materially higher trust bar): write approved categorisations back to Xero via API**, one
line at a time, only for lines with a recorded `approval` from the accountant. This is the point
where `reserved`-style caution matters most — no batch "approve all" shortcut for a whole page,
because that reintroduces exactly the un-reviewed-rubber-stamp risk the review step exists to prevent.

**Do not build Phase 2 before Phase 1 has run against at least one real backlog** (Global Buildtech's
own is the obvious first case) and the accountant confirms the proposals were actually useful, not
just plausible-sounding.

## 8. Risks, named rather than assumed away

- **The known `overrides`-tighten-only hole (`ORCHESTRATOR_SPEC.md` §7.2, flagged 2026-07-27) applies
  directly here.** This flow's `approve_before_send` override must itself be validated as
  at-least-as-strict as the computed band at policy-write time, per the spec's own fix requirement —
  fix that gap before this flow ships, not after, since a financial-write flow is exactly where the
  bypass would bite hardest.
- **Rubber-stamp risk.** A review queue of 1,274 AI-generated suggestions is only as good as whether
  a real professional actually reads each one. Design the queue for genuine reviewability (grouped by
  rationale/confidence, not a flat chronological list) rather than optimising for "technically
  reviewed."
- **Cost at scale.** A one-time backlog like Global Buildtech's is a bounded cost; templating this
  across every BBBO client means costing per-client LLM spend before wide rollout, not after.
- **Financial data reaching a third-party model is a live decision every time this runs** — see §5.
- **Personal vs. business separation** (the exact issue in Global Buildtech's own account) is a
  business-specific convention, not something the model can infer safely without either an explicit
  rule set or enough prior-coding history to learn it from — treat "no confident prior pattern and
  looks personal" as its own low-confidence category that surfaces distinctly, never guessed at
  silently.

## 9. What's explicitly NOT in scope here

Auto-approval of any kind, a general ledger write capability beyond bank-transaction categorisation,
payroll or BAS/GST lodgement (both sit in the policy's own `reserved` list already —
`tax_lodgement` — and stay there), and building this before Phase 1 has been proven against one real
account.
