# Execution Layer — what actually does the work

**Version** 0.1 — scoping draft
**Owner** Dennis McMahon, Corporate AI Solutions
**Companions** `ORCHESTRATOR_SPEC.md` (the dispatch seam) · `TASK_REGISTRY.md` (the 140 flows)

> `ORCHESTRATOR_SPEC.md` §5 ends with *"one model call, ends in a handoff."* This document is what
> is on the other side of that handoff. It is the larger half of the build.

---

## 1. The seam

The orchestrator answers **what should happen and who must approve it**. The execution layer answers
**how it actually happens in the world** — the email that genuinely sends, the invoice that genuinely
appears in Xero, the appointment that genuinely lands in a diary.

```
envelope → route → gate → [ HANDOFF ] → handler → tools → effects → outbox → the world
                                            ↓                              ↓
                                          trace                      task_events
```

Everything left of the handoff is decision. Everything right of it changes something, which is why
the failure modes are different in kind: a routing mistake produces a wrong task you can cancel; an
execution mistake produces an email a client has already read.

---

## 2. The seven components

| # | Component | What it is | Without it |
|---|---|---|---|
| 1 | **Canonical store** | The Postgres entity layer (`ORCHESTRATOR_SPEC.md` §9) | Nothing has a stable ID; agents write three versions of the same client |
| 2 | **Scheduler** | One timer service driving `CAL` ingress, `STA` sweeps, SLA checks, retries | 40% of the registry has no trigger |
| 3 | **Handler runtimes** | Four executors, one per tier (§4) | Nothing runs |
| 4 | **Tool layer** | The interface handlers reach the world through, with a hard read/write split (§6) | Agents route around gates |
| 5 | **Effects + outbox** | Durable, idempotent record of every intended change to the world (§5) | You cannot answer "did it actually send?" |
| 6 | **Connectors** | Adapters to the systems a business already runs (§3) | The system is a very expensive notepad |
| 7 | **Drafts + review queue** | The artifact an approval gate holds, and the surface it's held on (§7) | `approve_before_send` has nothing to approve |

Components 1, 2, 3(mechanical), 5, 7 plus **one** connector deliver the first twenty flows. See §11.

---

## 3. Connectors — the honest map

Counted against the 140-flow registry. This is the real surface area of the product, and it is the
reason the build must be sequenced rather than specified.

| Connector class | Flows touched | Examples | Priority |
|---|---|---|---|
| **Email — send** | ~50 | Every chase, quote send, confirmation, follow-up | **1st** |
| **Documents** | ~20 | Quote/invoice PDF generation, storage, e-signature | 2nd |
| **Accounting** (Xero / MYOB / QuickBooks) | ~30 | Invoices, POs, payments, bank feed, suppliers, credit notes | 2nd |
| **Calendar / scheduling** | ~15 | Appointments, crew allocation, reminders | 3rd |
| **Email — receive** | ~12 | Inbound enquiry, supplier confirmations, AP replies | 3rd |
| **Payments** | ~8 | Deposits, payment plans, refunds, chargebacks | 4th |
| **Inventory / stock** | ~10 | Reorder points, stocktake, transfers | 4th |
| **Telephony** | ~5 | Inbound call events (the `EVT` half of flow 1) | 4th |
| **Field / mobile capture** | ~10 | Photos, timesheets, POD, sign-off | 5th |
| **Payroll / HR** | ~10 | Mostly `reserved` — read-only for a long time | 5th |
| **Web research** | ~10 | Material rates, credit checks, tender portals | 5th |
| **SMS** | ~8 | Appointment reminders, urgent chase | opportunistic |

**Three rules that keep this from becoming an integrations company:**

1. **Read before write, always.** A connector ships read-only first and earns its write path. Reading
   Xero invoices unlocks the entire debtor-chase tranche without any ability to damage the ledger.
2. **The canonical store is not a mirror.** Sync IDs and the few fields the orchestrator routes on;
   do not replicate the accounting system. `DATA_STANDARD` I1 — one canonical source per domain, and
   for financial records that source is the accounting system, not us.
3. **Connectors are tenant-configured, not vertical-coded.** One accounting connector with a Xero
   adapter, not a trades-accounting connector and a healthcare-accounting connector.

---

## 4. The four handler runtimes

One per tier. Shares are measured across the registry, so effort should be read against them.

### 4.1 Mechanical — ~50% of flows, ~15% of the engineering

A deterministic composer. Given trigger + resolved params: evaluate conditions, render a template,
emit effects. **No model anywhere in the path.**

```yaml
handler: mechanical
when: { invoice.days_overdue: ">=30", invoice.status: unpaid }
compose:
  template: chase_30_day          # tenant-overridable, versioned
  channel: email
effects:
  - { type: email.send, to: contact.ap_email, from: tenant.identity }
  - { type: entity.update, target: invoice, set: { last_chased_at: now } }
```

Needs: a condition evaluator, a template store with tenant overrides and versioning, and an effect
emitter. That's the whole runtime, and it carries half the registry.

**Templates are content, and content is the tenant's voice.** They belong with the vertical pack and
the tenant override, not in code — and their approval happens once at activation (§7 of
`ORCHESTRATOR_SPEC.md`), which is what makes `notify`-band sends safe.

### 4.2 Conversational — ~25% of flows

One model call, structured in and structured out, **no loop**. Prompt lives in the manifest as
markdown; the output is schema-validated before it becomes a draft.

The discipline that keeps this tier from silently becoming agentic: **it gets read tools only, and it
gets exactly one call.** If a manifest needs a second hop, it is not conversational — reclassify it.

### 4.3 Agentic — ~14% of flows, most of the engineering

The loop: plan → call tools → evaluate → repeat → produce a result. Needs everything the other tiers
need plus:

- **A tool registry** scoped to the manifest's declared `tools`
- **Iteration cap** and **cost cap** — a hard stop, not a warning (`ORCHESTRATOR_SPEC.md` §8.2)
- **Its own evaluation** — the agent decides when it is done, against a stated success condition
- **A full trace** — every tool call, input, output, token cost, retained for debugging and for the
  §10 explanation surface

**Build exactly one first (quoting) and resist the second until it works.** Apart from quoting and
variations, the agentic flows are quarterly-frequency (RFP, regulator response, vendor questionnaire,
supplier renegotiation, pricing review). High effort, low repetition — see `TASK_REGISTRY.md` §5.3.

### 4.4 Assisted — ~11% of flows

**Not a no-op, and this is easy to get wrong.** The assisted handler does real work; it just does not
do *the* work. It:

1. **Prepares** — assembles a brief with everything the human needs (history, context, prior
   decisions, the relevant documents)
2. **Delivers** — into the review queue and the next session
3. **Captures** — provides a surface for the human to record the outcome
4. **Records** — the outcome becomes structured data and feeds the genome

Flow 79 (performance conversation) is the shape: Kira assembles six months of context and prepares
talking points; a human holds the conversation; the outcome is captured as a record. The system's
contribution is the prep and the memory, which is most of the value and none of the risk.

---

## 5. Effects and the outbox — the part that will bite

Every task that changes the world does so through **effects**. An effect is a typed, declared,
durable intent to change something.

**Use a transactional outbox.** The handler writes its effects to `effects` in the *same transaction*
as the task state change; a separate dispatcher picks them up, executes, and marks the outcome.
Without it you get the two failures that destroy trust fastest: *the system says it sent and it
didn't*, and *it sent twice*.

```
effects
  id · task_id · type · payload · idempotency_key
  status: pending | dispatched | succeeded | failed | abandoned
  reversible: bool          -- declared by the effect TYPE, not guessed per manifest
  attempts · last_error · dispatched_at · confirmed_at · external_ref
```

Three properties are non-negotiable:

- **Idempotent.** Every effect carries a key; the connector uses the provider's idempotency mechanism
  where one exists (Stripe, Resend, Xero all have one).
- **Confirmed, not assumed.** `succeeded` requires the provider's acknowledgement and stores its
  reference. "We called the API" is not "it happened."
- **Reversibility is a property of the effect type.** `email.send` is irreversible. `calendar.book`
  is reversible. `invoice.issue` is reversible-with-a-credit-note, which is a third thing.

**This closes the loop with the gate model.** `ORCHESTRATOR_SPEC.md` §7.2 makes reversibility one of
the three axes that set the approval band — and reversibility should be *derived from the effects a
manifest declares*, not hand-asserted on the manifest. If a manifest emits an irreversible effect,
the band tightens automatically. A manifest cannot accidentally under-declare its own risk.

### 5.1 Failure semantics

| Class | Handling |
|---|---|
| **Transient** (timeout, 5xx, rate limit) | Retry with backoff, capped. Stays `pending`. |
| **Permanent** (400, invalid recipient, auth revoked) | `failed`, surfaced to the review queue with the provider's actual error text, never a generic one. |
| **Ambiguous** (connection dropped mid-request) | **The dangerous one.** Never blind-retry. Reconcile against the provider using the idempotency key or external ref before deciding. |

A failed effect must reach the owner at the next session. `ORCHESTRATOR_SPEC.md` §13 names silent
failure as the top risk; the outbox is where that promise is kept or broken.

---

## 6. Tools and the write boundary — the safety finding

Manifests declare `tools: [past_quotes, material_rates, capacity_check, web_research]`. Tools are the
interface handlers reach connectors through, resolved per tenant so `material_rates` means one thing
for a landscaper and another for an equipment-hire firm without the manifest knowing.

**The important part: tools split into READ and EFFECT, and the split is enforced, not documented.**

An approval gate applied only at dispatch is a gate an agentic loop can walk around. If
`quote_nonstandard_job` is `approve_before_send` but the agent holds an `email.send` tool for the
duration of its loop, then "produce a draft and stop" is a request, not a constraint — one bad
reasoning step and the quote is with the client.

So:

- **Read tools** are available to any handler at any time. They cannot change the world.
- **Effect tools are not in the agent's tool set at all.** A handler *emits effects*; it does not
  *perform* them. The outbox dispatcher performs them, and only after the gate has cleared.

That single inversion — handlers propose effects, a separate dispatcher executes them — is what makes
the gates in `ORCHESTRATOR_SPEC.md` §7 structurally true rather than behaviourally hoped-for. It is
defence in depth: the gate decides whether the task runs, and the architecture decides that a running
task cannot reach the world on its own.

---

## 7. Drafts and the review queue

`approve_before_send` means "produce a draft, stop, wait" — so a **draft is a first-class entity**,
not a string on a task.

```
drafts
  id · task_id · version · content · rendered_preview
  edited_by · edit_diff · approved_by · approved_at · superseded_by
```

Three consequences worth designing for:

1. **Edits are signal.** An owner who approves a draft unchanged is telling you something different
   from one who rewrites the second paragraph every time. The trust ratchet
   (`ORCHESTRATOR_SPEC.md` §7.2) widens on *unchanged* approvals only. Capturing the diff makes that
   measurable rather than notional.
2. **Approval binds to a version.** Approving draft v2 must not release v3. Obvious, routinely got
   wrong, and the failure is a client receiving something nobody approved.
3. **The preview is what was approved.** Store the rendered artifact, not just the source. "What
   exactly did I agree to?" has to be answerable months later.

The review queue is the approval surface (`ORCHESTRATOR_SPEC.md` §4.3) — one plugin role among
three, so a tenant may run web-only, voice-only, or both.

---

## 8. Scheduler

One timer service, four consumers. Do not build four.

| Consumer | Cadence |
|---|---|
| `STA` sweeps — threshold rules over canonical rows | Per-rule, typically hourly or daily |
| `CAL` ingress — calendar-triggered flows | Per-rule cron |
| SLA breach detection | Every few minutes over non-terminal tasks |
| Outbox retry / reconciliation | Continuous with backoff |

Sweep rules are **data, not code** — a threshold rule is
`{ entity, condition, task_type, bucket, on_behalf_of }`, which is what lets flow 83 (licence expiry)
and flow 127 (subcontractor insurance) be the same mechanism with different rows.

`on_behalf_of` is not optional. A sweep fires at 2am and nobody spoke, so the **rule** carries the
authority the resulting task runs under — whoever activated that flow, defaulting to the owner
(`ORCHESTRATOR_SPEC.md` §7.4). A task with no principal cannot have its gate resolved, and cannot
later be audited.

---

## 9. Execution identity and compliance

**Who does the system act as?** Not a detail — a trust and legal question.

- **It sends as the business, and it says so.** A recipient must never be misled about corresponding
  with an assistant. This is the honesty that makes the whole product defensible, and it costs
  nothing: *"Sent on behalf of [business] by their assistant"* in the footer, with a real reply path
  to a human.
- **Australian Spam Act compliance is mandatory in the send path.** Every commercial message carries
  sender identity + ABN + functional unsubscribe. Wire `@caistech/email-compliance` —
  `assertCompliant()` in the outbox dispatcher so a non-compliant send *throws* rather than sends,
  plus `assertJurisdictionAllowed()` (AU only; non-AU hard-blocks). Chase emails, review requests and
  reawakening campaigns are all commercial messages.
- **Identity is the tenant's, never ours.** `PRODUCT_STANDARDS` §9 "whose brand travels" — the
  business's entity and ABN in every outbound artifact, not Corporate AI Solutions'.
- **Suppression is honoured at the dispatcher**, not at the composer. A `notify`-band chase to someone
  who unsubscribed must not send, and the check belongs where every effect passes.

Reuse: `@caistech/email-send` (transport + footer + suppression), `@caistech/email-compliance`
(the assertions). Do not build a second send path.

---

## 10. Observability — "did it actually happen?"

Three questions must each be answerable in one query, because all three will be asked in anger:

| Question | Answered by |
|---|---|
| *What is this task doing right now?* | `task_events` — append-only state transitions with actor and timestamp |
| *Did that email actually reach the client?* | `effects` — provider ack + external ref + confirmed_at |
| *Why did the agent do that?* | `agent_traces` — tool calls, inputs, outputs, costs, iterations |

Plus a rollup the owner sees rather than the developer: **what did the assistant do this week, what
is it waiting on, and what failed.** That report is also the product's weekly proof of value, so it
is not an ops afterthought.

---

## 11. Sequencing — the minimum viable "doing" layer

The finding that should drive the build: **the first twenty flows need one connector.**

`TASK_REGISTRY.md` §6 identifies twenty flows that share a single pattern — sweep canonical rows,
find threshold breaches, compose from a template, gate, send. That tranche needs:

| Needed | Not needed |
|---|---|
| Canonical store | Agentic loop |
| Scheduler + sweep rules as data | Tool registry |
| Mechanical handler + templates | Accounting connector |
| Effects + outbox | Documents / PDF |
| Email send (compliant) | Calendar, payments, inventory |
| Drafts + review queue | Conversational handler |

That is a genuinely small build, and it delivers debtor chasing, quote follow-up, appointment
confirmation, expiry tracking and reorder alerts — the work a 200-person business feels immediately.

**Then, in order:**

| Tranche | Adds | Unlocks |
|---|---|---|
| **2** | Accounting connector, **read-only** | The money-in flows properly (41–50, 107–112) — real invoice state instead of a shadow copy |
| **3** | Conversational handler + document generation | ~35 flows: complaint responses, ticket triage, warranty, reawakening, newsletters, quotes-as-PDF |
| **4** | Tool registry + the first agentic loop (quoting) | 16, 20, 33 — the highest-value agentic cluster and the only high-frequency one |
| **5** | Calendar, accounting **write**, payments | Scheduling, invoice raising, deposits |
| **6** | Assisted handler + capture surfaces | The ~15 human-does-it flows, which are cheap once the review queue exists |

**Read-only connectors are the compounding move.** Reading Xero unlocks an entire tranche of flows
with zero ability to damage a client's ledger, and it buys the trust that makes the write path
acceptable later. Every connector should ship this way.

---

## 12. What we deliberately do not build

Naming these matters, because each one is a plausible-sounding trap that would consume the build:

- **A CRM UI.** The canonical store is an ID authority, not a product. If it grows a pipeline view
  and a contact editor, the scope has escaped.
- **An accounting system.** Xero exists. Connect to it; do not shadow it. (`DATA_STANDARD` I1.)
- **A scheduling optimiser.** Crew allocation (flow 28) is a constraint-solving rabbit hole. Propose
  and let a human confirm.
- **Dynamic agent generation.** Deferred behind the `unroutable_requests` log
  (`ORCHESTRATOR_SPEC.md` §5.4), revisited at 200 entries.
- **A second send path, a second voice stack, a second Mnemo client.** `@caistech/email-send`,
  `@caistech/elevenlabs-convai`, `@caistech/mnemo` all exist. The fork-check guard enforces this.

---

## 13. Decisions — resolved 2026-07-27

| # | Decision | Resolution |
|---|---|---|
| E1 | Which accounting system first | ✅ **Xero**, but the connector interface is written provider-agnostic from day one — MYOB and QuickBooks are expected, not hypothetical. Xero is the *first adapter*, never the interface. |
| E2 | Do handlers ever perform effects directly? | ✅ **Never.** Handlers emit; the dispatcher performs. §6. |
| E3 | Templates in-manifest or separate store? | ✅ **Separate content store**, versioned, with its own approval-at-activation record. Templates are tenant voice and change far more often than manifests. |
| E4 | Reversibility derived or asserted? | ✅ **Derived** from the effects a manifest declares. §5. Requires the effect catalogue up front — accepted. |
| E5 | Where the outbox dispatcher runs | ✅ **Postgres is the queue.** See §13.1. |
| E6 | Assistant disclosure | ✅ **Explicit footer line + a real human reply path.** A trust asset, not a disclaimer. |

### 13.1 E5 — the outbox is the queue

**The workload is low-volume and high-stakes.** The avatar generates hundreds of effects per day per
tenant, not millions. Queue infrastructure earns its keep at throughput; this build is optimising for
**correctness and inspectability**, which points somewhere different.

**Options considered:**

| Option | For | Against |
|---|---|---|
| **Vercel Queues** | Native to the stack, at-least-once (we have idempotency keys), zero infra, scales unattended | **Public beta** on the most consequential path in the system · vendor-coupled · a stuck message is harder to inspect than a row · **splits the truth** (see below) |
| **Postgres table + worker** (`FOR UPDATE SKIP LOCKED`) | The queue *is* the audit record · full SQL visibility · portable · retry state sits next to the effect | You write the runner: claim, backoff, dead-letter · polling latency |
| **pgmq / graphile-worker** | As above, without hand-rolling locking and backoff · visibility timeouts, archive, cron built in | One more dependency · still needs a host to run in |
| **Inngest / Trigger.dev / QStash** | Retries, backoff and a genuinely good observability UI, solved | Another vendor, bill and failure domain · **effect payloads contain client correspondence**, so this is a data-residency question, not just an ops one |
| **Temporal** | Perfect durable-execution semantics | Operationally enormous for hundreds of messages a day |
| **Vercel Workflow (WDK)** | Durable, crash-safe, step semantics fit the effect lifecycle well | Newer · vendor-coupled on the critical path |

**Decision: the `effects` table in Postgres is the single source of truth and the queue, claimed with
`SKIP LOCKED` (or `pgmq` if it earns its keep), drained by a Vercel Cron function every minute.**

The deciding argument is **one source of truth about what is in flight.** §10 requires *"did that
email actually reach the client?"* to be a one-query answer. Put pending state in an external queue
and the audit record in Postgres, and there are now two systems that disagree about what is
happening — which is precisely the class of bug that produces *"the system says it sent and it
didn't."* With the table as the queue, the queue **is** the record. That is `DATA_STANDARD` D1
applied to our own machinery.

Supporting arguments: portability (this layer is meant to be substrate, so binding its most critical
path to a beta vendor product is the wrong bet), and inspectability (*"show me everything stuck"* is
a `SELECT`, at 3am, without a dashboard).

**Where the vendor products still earn a place: as the trigger, not the store.** A cron drain every
minute is adequate for chases and reminders. For anything that should feel immediate, a queue message
can *wake* the dispatcher — which then reads Postgres. Latency improves; the truth doesn't move.

Implementation notes: cap attempts and dead-letter into the review queue with the provider's actual
error text; back off exponentially with jitter; make the drain function idempotent and safe to run
concurrently; hold ordering per-entity only (never send a chase after its own cancellation), not
globally.

---

## 14. Build vs buy

The question deserves a real answer rather than a defensive one, because a large part of this
document **is** commodity and should be bought or consumed.

### 14.1 The split

| Buy / consume — it is commodity | Build — it is the product |
|---|---|
| **Agent loop mechanics** — tool calling, iteration, planning, traces (Claude Agent SDK, Vercel Eve) | **The delegation model** — bands, reversibility, `reserved`, trust ratchets, elicited in conversation |
| **Durable execution / retries** | **The registry as a business ontology** — 140 flows classified by ingress × tier × gate, three-level inheritance |
| **LLM routing** (AI Gateway) | **The five-ingress model**, with `STA` (absence) as first-class |
| **Voice** — `@caistech/elevenlabs-convai`, already consumed | **Canonical entity resolution as a precondition to action** |
| **Semantic memory** — Mnemo, already a partner product | **The elicitation layer** — getting ground rules out of an owner's head |
| **Email transport + compliance** — `@caistech/email-send`, `email-compliance` | **The effects/outbox contract** — because it is also the audit record |
| **Connectors to common SaaS** — strongly consider a unified API (Merge.dev-class) over hand-writing Xero + MYOB + QuickBooks | |

**The rule that produces this split:** buy anything where a vendor's failure means *painful
migration*; build anything where a vendor's failure means *you no longer have a product*. Agent loops
and queues are swappable.

> ⚠️ **Overstated — corrected 2026-07-27 (eng review).** An earlier revision said the delegation
> model is *"not purchasable at any price."* It isn't. Spend bands, role ceilings, approval routing
> and second-approver thresholds are the core of every AP/procurement product (Coupa, Ramp, Airbase,
> Pleo) and are in Xero's own approval rules; Agentforce ships permission-scoped agent actions with
> approval steps today.
>
> What is genuinely uncommon is narrower: **reversibility as a first-class axis** (real, but it's a
> labelling exercise over an effect catalogue — replicable in a sprint) and **elicitation in
> conversation** (a prompt plus a form; any incumbent ships an "AI onboarding interview" in a
> quarter).
>
> **The durable asset is not the model — it's the accumulated tenant-specific ground rules.** That
> is a switching cost, and switching costs only accrue with customers. Which means the moat is
> downstream of distribution, not upstream of it.

### 14.2 The uncomfortable comparison — is this Zapier with an LLM?

Worth confronting rather than assuming the answer. Four things distinguish it, and **all four are in
the parts most likely to get cut for time**:

1. **An approval model.** Zapier, Make and n8n have no concept of *ask the boss*. Agentforce has
   approval steps, but as workflow nodes — not a delegation schedule with limits, reversibility and
   earned trust.
2. **Absence triggers.** iPaaS is overwhelmingly webhook-in / action-out plus cron. *"Nothing
   happened and that is the problem"* is weakly supported everywhere, and it is 23% of the registry
   and the highest early value.
3. **Canonical entity resolution.** Most agent frameworks semantic-search for a client and hope.
4. **The elicitation conversation** that establishes what the system is allowed to do.

Cut the delegation model and the elicitation layer for schedule reasons and the honest answer becomes
*"yes, basically"* — a well-built automation tool in a crowded category. They are not the polish;
they are the thesis.

### 14.3 The strategic complication — SUPERSEDED 2026-07-27

> ⚠️ **This section is wrong in two ways and is kept only as a record of the reasoning.**
>
> **(1) Factually.** Simpro Group launched **Lightning** on 13 May 2026 across Simpro, AroFlo **and**
> BigChange, with **Cooper** underneath it — positioned as *"an AI orchestration engine rather than a
> chatbot."* Three of the four platforms named below are **one company**, and that company shipped
> this capability first. Tradify has no public API, no webhooks and no Zapier, so it cannot be an
> integration partner at all. Only **ServiceM8** was ever viable.
>
> **(2) Strategically.** The channel is no longer platform-distribution. It is **brokers and
> accountants across Australia, as REFERRERS**, with the business owner paying us directly. Nobody
> in the list below is a distributor of this product. See the CEO plan, rev 3
> (`~/.gstack/projects/orchestrator/ceo-plans/2026-07-27-radar.md`).
>
> What survives: the **projected entity mode** conclusion (§9) — deferring to an incumbent system of
> record is still right, and the accountant's Xero export is now how the data actually arrives.

#### Original text (retained for the record)

`ORCHESTRATOR_SPEC.md` §9 says the canonical store *"replaces a CRM."* For a solo operator, true. But
the business model sells to **distributors who already have a book of customers** — and for this
avatar the plausible distributors are Simpro, ServiceM8, AroFlo, Tradify. Those platforms already own
the contacts, jobs, quotes and invoices for thousands of trade businesses.

That is a threat and an opportunity in the same fact. It means:

- **The canonical store must be able to defer to a system of record**, not always be one. Same
  interface, two modes: *authoritative* (no incumbent) or *projected* (IDs and routing fields mirrored
  from the distributor's platform, which stays canonical per `DATA_STANDARD` I1).
- Insisting on being the system of record makes every distributor conversation a rip-and-replace
  conversation, which is the hardest sale there is.
- The delegation layer, by contrast, is **additive to any of them** — none has it, and it sits above
  whatever holds the entities.

This should be settled before the canonical store's schema hardens, because retrofitting a projected
mode is expensive. Recorded as **E7**.

### 14.4 What "buy" costs that is easy to miss

- **Connector vendors see the payloads.** Unified-API products proxy the data. For client
  correspondence and financial records that is a privacy and residency question, not a pricing one.
- **The AI-employee category is churning.** Building the moat on a vendor whose roadmap you don't
  control inverts the moat.
- **Every bought component is a compliance surface** you still own — the Spam Act obligations in §9
  do not transfer to the transport provider.

| # | Decision | Note |
|---|---|---|
| E7 | Does the entity layer support a `projected` mode? | ✅ **Resolved, and stronger than proposed: projected is the DEFAULT.** See §15. |
| E8 | **Unified connector API (Merge.dev-class) or hand-written adapters?** | 🔴 Trade-off is speed and breadth against payload custody and per-tenant cost. Recommend hand-writing Xero first (it sets the interface), then evaluating a unified API for the tail. |

---

## 15. The integrate-don't-replace rule

**Locked 2026-07-27.** *A business has tools it uses. We do not build something that is already
there. We build where a tool is not there.*

This resolves E7 by decision rather than analysis, and it goes further than E7 proposed — **projected
is the default mode, authoritative is the fallback** (`ORCHESTRATOR_SPEC.md` §9).

### 15.1 What it deletes from the build

Naming the savings, because they are large:

- No contact-management UI, no quote/invoice CRUD, no pipeline views
- No agonising over which of fourteen tables is authoritative — the entity layer is **two tables plus
  a pointer home**
- No data-migration story at onboarding, which is otherwise the single biggest barrier to a first
  install
- No competing with Xero, Simpro or ServiceM8 on features they have spent a decade building

### 15.2 The finding that makes this more than a concession

Ask which registry flows a 200-staff business has **no tool for at all**, and the answer is a
recognisable list:

| Flow | What they actually do today |
|---|---|
| 26 Collect compliance docs from the client | Email, then memory |
| 83 / 123 / 127 / 130 Licence, rego, subbie insurance, staff certificate expiries | A spreadsheet, or nothing |
| 137 / 139 Contract obligations, retention release | Nothing |
| 9 / 19 / 22 Lead, quote and contract follow-up | Memory, and a sticky note |
| 58 Chase a late supplier delivery | Memory |
| 65 / 66 / 67 Review asks, satisfaction checks, reawakening | Nothing |
| 132 Duplicate customer records | Nothing, ever |
| 89 Vendor compliance questionnaires | Panic |

**That list is very nearly the twenty-flow Phase 2 tranche** (`TASK_REGISTRY.md` §6). The convergence
is not a coincidence:

> **The things nothing happened about are the things nothing owns.** The absence-trigger class
> (`STA`) and the tool-absence class are close to the same class — work falls through the cracks
> precisely because no system holds it.

Meanwhile the contested flows — quoting, invoicing, scheduling, stock — all have incumbents, and they
are also the expensive ones to build. So the sequencing that was already cheapest is also **the least
contested ground on the map.** Phase 2 competes with nobody.

### 15.3 The coverage map — two sources, and their disagreement is the point

If we only build where a tool is absent, finding out what is present becomes load-bearing. It has
**two independent sources**, and neither is sufficient alone:

| Source | Captures | Misses |
|---|---|---|
| **The conversation** (Kira, `ORCHESTRATOR_SPEC.md` §7.3) | Intent, workarounds, the spreadsheet nobody admits to, *"we have it but nobody updates it"*, why a tool was abandoned | Tools the owner forgot, never knew about, or that a department adopted alone |
| **The systems sweep** (§16) | What is actually running, actually paid for, actually receiving data | Why. Whether anyone trusts it. What happens outside every system. |

**Where they disagree is often the actual business problem.** *"You said quotes go through Simpro;
40% of your invoices have no matching Simpro job"* is a finding worth paying for on its own, and it
falls out of onboarding for free.

So the coverage map is drafted by the sweep and **corrected and enriched** in the hour — not created
from nothing while an owner tries to remember.

#### Three states, not two

The critical distinction, and the one a naive coverage map gets wrong:

| State | Meaning | Behaviour |
|---|---|---|
| **Absent** | Nothing owns this flow | Authoritative mode. **The wedge** — most obvious value, zero resistance. |
| **Present and used** | A tool owns it and the data is real | Projected mode. Connect, index, sweep the projection, confirm against the source. |
| **Present but unused** | A tool owns it on paper; the fields are empty | **Treat as absent for coverage, present for integration.** We populate *their* tool rather than starting a parallel one. |

That third state is the one that matters. Mark a flow "covered by Simpro" when Simpro's asset module
is 80% empty and we have just decided not to build the thing the business actually needs. It is also
the strongest pitch on the map: *"you're already paying for this module and nobody fills it in — I
can keep it current."* Driving an existing tool beats both replacing it and duplicating it.

#### The closed-tool case

*"We use [tool], but it has no API."* Functionally absent for our purposes — but that is not a
licence to quietly become the system of record. Hold the minimum needed to operate, mark it plainly
as a working copy, disclose it, and re-check when the vendor ships an API.

---

## 16. Systems discovery — the sweep and the tool register

Asking a business owner to list their software produces an incomplete list, confidently given. The
sweep produces the real one.

### 16.1 The first connector is also the discovery mechanism

**A business's accounting system contains a complete, dated, authoritative list of every piece of
software it pays for.** The supplier ledger and recurring payments in Xero enumerate the entire
software estate — including the tools nobody would have mentioned.

This is a fortunate alignment: read-only Xero is already connector #1 in §11's sequencing for
unrelated reasons (it unlocks the money-in tranche). It arrives doubling as the discovery engine.

Discovery signals, in order of value:

| Signal | Tells you |
|---|---|
| **Accounting supplier ledger + recurring payments** | What they pay for, since when, how much — the estate |
| **Inbound email senders** (`noreply@simprosuite.com`) | What is actually *in use* — a tool that sends notifications has a live user |
| **Email platform / MX** | Google Workspace vs M365, which shapes the calendar and mail connectors |
| **OAuth enumeration** once connected | Sub-tools, connected apps, integrations already wired |
| **Data probes** after connection | Record counts, last-updated dates, field-population rates — the *present-but-unused* signal |

The last row is what separates presence from use, and it cannot be obtained by asking.

### 16.2 The tool register

A first-class artifact alongside the Ground Rules and the coverage map. Per tool:

```
tool_register
  name · vendor · category
  evidence         -- ledger entry | inbound sender | oauth | stated by owner
  status           -- in_use | paid_but_idle | decommissioned | unknown
  integration      -- rest_api | webhooks | unofficial | none
  adapter          -- ours | vendor_sdk | unified_api | build | buy | none_possible
  flows_covered    -- registry flow ids
  connection_state · credential_ref · last_verified_at
```

`paid_but_idle` earns its own status because it is both a finding for the owner (**registry flow 97 —
manage software licences and subscriptions — delivered as a by-product of onboarding**) and a coverage
correction for us.

### 16.3 Build / buy / use — the adapter decision, per tool

Four routes, evaluated in this order:

1. **Use** — a `@caistech` adapter exists, or the vendor ships a usable SDK. Always first.
2. **Buy** — a unified API (Merge.dev-class) covers the category, or an embedded iPaaS connector
   backend (self-hosted n8n has 400+ integrations and is a legitimate *connector layer* even where it
   is the wrong workflow engine). Trade-off is payload custody — see §14.4.
3. **Build** — hand-write. Justified when the tool covers many flows, or sets an interface others
   conform to (Xero, per E1).
4. **None possible** — no API. The flow falls back to authoritative mode or the assisted tier. Record
   it; do not pretend coverage.

Sequence adapter work by **how many registry flows each unlocks**, which the register makes
computable rather than intuitive.

### 16.4 Where the sweep sits in onboarding

The sweep runs **before** the hour, not after — this is what makes Kira "come prepared"
(`ORCHESTRATOR_SPEC.md` §7.3) real rather than aspirational.

1. **Connect** — read-only access to one anchor system (accounting) and email
2. **Sweep** — enumerate the estate from the ledger and inbound senders
3. **Probe** — per discovered tool: is there an API, can we reach it, is there data in it
4. **The hour** — Kira arrives with a *draft* register and coverage map: *"I can see you're paying for
   Simpro and Deputy. Do you use both? The asset module looks empty — is that deliberate?"*
5. **Agree** — the corrected register and coverage map, versioned, owner-visible
6. **Plan** — build/buy/use per adapter, sequenced by flows unlocked

Opening with specifics instead of *"what tools do you use?"* is the entire difference between this and
an integrations checklist.

### 16.5 The register is maintained, not captured once

Businesses adopt tools. A new supplier-ledger entry matching a known SaaS vendor is a trigger:
*"you've started paying for something called Deputy — want me to connect it?"* That is the sweep as a
standing `STA` flow rather than an onboarding step, and it keeps the coverage map from rotting.

### 16.6 Constraints — this is an audit of someone's business

- **Consent per system, read-only first, disclosed.** The owner authorises each connection and can
  see and revoke every one. This is not a covert audit, and it must never feel like one.
- **Enumerate, don't hoover.** We discover *which* tools exist and probe *whether* they hold data. We
  do not pull contents we have no flow for. `DATA_STANDARD` I4/S4.
- **Shadow IT is delicate.** The sweep will surface tools the owner did not know about, sometimes
  paid for personally by an employee. Present as information, never as accusation.
- **Every connection is a credential we hold.** Per-tenant, encrypted, revocable, listed in the
  register with `last_verified_at`. A stale credential must fail loudly, not silently stop sweeping.

### 15.4 The commercial read

*"We don't replace anything you already use"* is the lowest-friction entry available, and it is true
rather than a positioning line. The gaps we fill are the unglamorous ones nobody built a product for
— which is exactly why they are unfilled, and exactly why there is no incumbent to displace.

It is also the better distributor story. A distributor platform is not a competitor to be worked
around; it is the system of record we index, and the delegation layer sits above it, additive. None
of them has one.
