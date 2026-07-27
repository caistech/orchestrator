# Task Registry — the seed flow library

**Version** 0.1 — working file
**Status** Draft for review. Classifications are first-pass and expected to move.
**Purpose** Three jobs at once: (1) the roadmap — what gets built and in what order; (2) the test corpus for the classifier's acceptance criteria; (3) the evidence that the orchestrator abstraction is real rather than a voice product wearing a coat.

> ⚠️ **STATUS 2026-07-27: purpose (1) is DEFERRED — this is not the current roadmap.**
>
> The build was cut to a **radar** and then re-centred on the **valuation loop**: an advisor refers
> an owner, the owner runs a 3-minute valuation, and the product closes the gap between their
> current and potential sellability. The current plan is `VALUATION_LOOP.md` +
> `ADMISSION_TESTS.md`, with open decisions in `TODOS.md`.
>
> **What is deferred:** the 140 flows as a build sequence. Nothing here is being worked through in
> order, and a session that reads this as "what gets built next" will build the wrong thing.
>
> **What still stands:** purposes (2) and (3). The registry remains the evidence that the
> orchestrator abstraction is real, and the corpus a classifier would eventually be judged against.
> It also holds the operational flows that the **owner-dependence** factor measures — a task running
> without the owner is a row in here — so it is the raw material for `ADMISSION_TESTS.md` §2, not a
> discarded document.

---

## 1. The avatar

> **~200 staff. Sells and services both trade accounts and walk-up consumers. Holds inventory. Does field work. Operates from more than one site.**
> Think building products, equipment hire, healthcare services, automotive.

Each of those five attributes is load-bearing, and the reason to pick this profile is **maximality**: every attribute generates a class of flow that a business without it simply doesn't have.

| Attribute | Generates |
|---|---|
| **Dual-channel** (trade + consumer) | Credit lifecycle, PO matching, statement cycles, account holds — *and* deposits, consumer returns, chargebacks. A single-channel business gets half. |
| **Holds inventory** | Reorder points, stocktake, supplier returns, inter-branch transfer, catalogue/SKU ops. |
| **Field work** | Scheduling, crew allocation, site compliance, variations, proof of delivery, subcontractors. |
| **Multi-site** | Branch reporting, transfer, local-vs-central authority limits. |
| **~200 staff** | Roles have specialised, so tasks are actually separable and observable. Below ~20 staff tasks collapse into people and the list under-decomposes; above ~1,000 you add a governance layer (board, investor relations, works council) no SME shares. |

**Why maximal matters.** §6 of the spec commits to *"a shared library of manifests, with per-tenant activation."* That only works if provisioning a new tenant is **deactivation**, not extension. A pure-consumer retailer switches off the trade block. A services firm with no inventory switches off fulfilment. If the avatar were smaller, every new tenant would mean writing manifests, and the shared library would be a fiction.

So the shoe is the right shoe — and it should stay deliberately one size too big.

---

## 2. Is 100 comprehensive? — the honest read

**The ten flow groups are the right spine.** Nothing in the original list is misplaced and the grouping-by-flow-not-department decision is what makes the whole thing usable.

**But the coverage has real gaps, and the granularity is uneven.** Two separate problems:

### 2.1 Coverage — seven areas were thin or missing

Added below and marked `+`:

| Gap | Why the avatar needs it |
|---|---|
| **Catalogue & pricing ops** | The original has "update website pricing" (7) and "review pricing" (95), but nothing on creating a SKU, versioning a rate card, or passing a supplier price rise through to customer rates. That last one is one of the most painful recurring flows in a dual-channel business. |
| **Trade account lifecycle** | Credit check at onboarding (23) exists; credit limit review, account hold/release, statement cycle, statement dispute, terms variation, bad-debt write-off do not. This is where a trade-account business actually lives. |
| **Fulfilment & logistics** | Nothing between "do the work" (32) and "raise the invoice" (41). No pick/pack, freight booking, dispatch notification, POD, delivery exception, consumer return, inter-branch transfer. |
| **Assets, fleet & equipment** | Only "approve a capital purchase" (100). No registration, servicing schedule, breakdown, rego/compliance renewal, assignment tracking, disposal. For the equipment-hire variant this is the core of the business. |
| **Contractors & external labour** | Employees are covered (71–80); subcontractors are a different lifecycle with different risk — insurance currency, work orders, claim approval. |
| **Data & records hygiene** | Dedupe/merge, contact detail updates, supplier bank-detail verification. The first of these is directly load-bearing for §8's canonical-entity argument; the third is a live fraud vector that deserves its own gate. |
| **Contract & obligation management** | RFP response (99) exists but nothing about what happens after you win — milestones, variations, retention release, defects liability. |

That takes the list from 100 to **140 flows**.

### 2.2 Granularity — the 100 is a list of *flows*, not a list of *manifests*

This is the more important finding. The expansion factor is wildly uneven:

- **"Take a deposit" (25)** is one manifest. Trigger, entities, params, gate, tier — all singular.
- **"Run payroll" (76)** is at least six: import timesheets → resolve exceptions → calculate → approve → disburse → lodge STP → distribute payslips → reconcile. Different gates on nearly every step. It is a *flow*, not a task.
- **"Do the work or fulfil the order" (32)** is **zero** core manifests. It's the vertical's entire domain and belongs in the vertical pack, not the shared library.
- **"Chase 30-day" (45)** and **"escalate 60/90" (46)** are arguably *one* manifest with a stage parameter — same entity, same tier, different template and gate.

**The test for whether something deserves its own manifest** is whether it has a distinct tuple of *(ingress, entity set, required params, gate, tier)*. Same tuple → one manifest with a param. Different gate on different paths → separate manifests.

**Conclusion: ~140 flows expand to roughly 200–260 core manifests for this archetype**, and the registry therefore needs two levels:

| Level | Unit | Who reads it | Count |
|---|---|---|---|
| **Flow** | Human-readable business outcome | Dennis, a prospect, a tenant during provisioning | ~140 |
| **Manifest** | Machine-routable task type | The orchestrator | ~200–260 |

Do **not** collapse these. The flow is what you sell and what a tenant activates; the manifest is what the router resolves to. Collapsing them is how the §11 registry-sprawl risk lands.

### 2.3 So do we need to get extremely granular?

**Not yet, and not by hand.** Manifest-level granularity is only worth writing for flows you are about to build. The right move is to keep the 140 flows as the stable spine, expand a flow into manifests when it enters the build queue, and let the `unroutable_requests` log tell you where the real decomposition boundaries are — which is exactly what §5 says that table is for.

Writing 250 manifests up front means writing ~200 of them against imagined triggers.

---

## 3. Classification scheme

### Ingress — what actually kicks it off

| Code | Class | Definition |
|---|---|---|
| `EVT` | External system event | Something arrived — form submission, payment, inbound call, supplier notification, ticket |
| `STA` | State threshold or absence | Nothing happened and that *is* the trigger — an invoice aged, a lead went quiet, stock hit minimum, a certificate approaches expiry |
| `CAL` | Calendar | Fixed schedule — payroll, month-end, quarterly lodgement |
| `SAY` | Human utterance | Someone asked for it in words. **This is the Kira path.** |
| `HUM` | Human-initiated, system-assisted | A person does the thing; the system prepares, reminds, and captures |

### Tier

| Code | Tier | Definition |
|---|---|---|
| `M` | mechanical | Given trigger + data, the correct action is fully determined. No model in the path. |
| `C` | conversational | Needs language in or out, but one hop. Single model call, no loop. |
| `A` | agentic | Cannot know in advance what information is needed. Agent loop with tools. |
| `H` | assisted | A human does the work. The system preps, reminds, captures the output. **Never automate these.** |

### Gate

| Code | Gate |
|---|---|
| `–` | none — executes and completes silently |
| `N` | notify_on_complete |
| `S` | human_approval_before_send |
| `B` | human_approval_before_start |

### Frequency (drives build order)

`hi` = many times a week · `md` = weekly-to-monthly · `lo` = quarterly or rarer

`Mf` = estimated core manifest count. `0` = vertical-owned, not in the shared library.

---

## 4. The registry

Original numbering preserved. `+` marks flows added in this pass.

### 4.1 Getting attention

| # | Flow | In | Tier | Gate | Freq | Mf |
|---|---|---|---|---|---|---|
| 1 | Answer an inbound call and work out what the person wants | EVT | C | – | hi | 1 |
| 2 | Respond to a web form enquiry | EVT | C | S | hi | 1 |
| 3 | Reply to a social DM or comment asking about product | EVT | C | S | hi | 1 |
| 4 | Determine trade vs consumer and route accordingly | EVT | M | – | hi | 1 |
| 5 | Publish a scheduled social post | CAL | M | N | md | 1 |
| 6 | Write and send the monthly newsletter | CAL | C | S | lo | 2 |
| 7 | Update pricing or product info on the website | EVT | M | B | md | 2 |
| 8 | Respond to a directory or marketplace enquiry | EVT | C | S | md | 1 |
| 9 | Chase a lead that went quiet | **STA** | C | S | hi | 1 |
| 10 | Record where a lead came from so attribution works | EVT | M | – | hi | 1 |

### 4.2 Scoping and quoting

| # | Flow | In | Tier | Gate | Freq | Mf |
|---|---|---|---|---|---|---|
| 11 | Book a site visit or discovery call | SAY | C | N | hi | 2 |
| 12 | Gather requirements from the client | HUM | H | – | hi | 1 |
| 13 | Check whether we've done this job before and what we charged | SAY | M | – | hi | 1 |
| 14 | Look up current input and material costs | SAY | M | – | hi | 1 |
| 15 | Check capacity — can we deliver in the window | SAY | M | – | hi | 1 |
| 16 | Build the quote or proposal | SAY | **A** | S | hi | 3 |
| 17 | Get internal approval on non-standard pricing | EVT | M | B | md | 1 |
| 18 | Send the quote | EVT | M | S | hi | 1 |
| 19 | Follow up at day 3, 7, 14 | **STA** | C | N | hi | 1 |
| 20 | Handle a "can you sharpen the price" negotiation | SAY | **A** | S | md | 1 |

### 4.3 Winning and setting up

| # | Flow | In | Tier | Gate | Freq | Mf |
|---|---|---|---|---|---|---|
| 21 | Convert an accepted quote into a job or order | EVT | M | – | hi | 1 |
| 22 | Chase the signed contract or terms acceptance | **STA** | C | S | hi | 1 |
| 23 | Run a credit check on a new trade account | EVT | C | B | md | 2 |
| 24 | Create the customer record with billing details | EVT | M | – | hi | 2 |
| 25 | Take a deposit | EVT | M | N | hi | 1 |
| 26 | Collect compliance docs from the client | **STA** | C | N | md | 2 |
| 27 | Schedule the work | EVT | M | N | hi | 2 |
| 28 | Allocate people or crew to it | EVT | C | N | hi | 1 |
| 29 | Send the "here's what happens next" message | EVT | M | – | hi | 1 |
| 30 | Order job-specific materials | EVT | M | B | hi | 1 |

### 4.4 Delivering

| # | Flow | In | Tier | Gate | Freq | Mf |
|---|---|---|---|---|---|---|
| 31 | Confirm the appointment 24 hours out | **STA** | M | – | hi | 1 |
| 32 | Do the work or fulfil the order | HUM | H | – | hi | **0** |
| 33 | Handle a variation or scope change mid-job | SAY | **A** | S | hi | 2 |
| 34 | Reschedule when weather, illness or supply blows up the plan | EVT | **A** | S | md | 2 |
| 35 | Record what was actually done — time, materials, photos | HUM | H | – | hi | 1 |
| 36 | Quality check before handover | HUM | H | – | hi | 1 |
| 37 | Handle a defect or rework request | EVT | **A** | S | md | 2 |
| 38 | Get client sign-off on completion | EVT | M | – | hi | 1 |
| 39 | Hand over documentation, warranties, manuals | EVT | M | N | hi | 1 |
| 40 | Close the job out in the system | EVT | M | – | hi | 1 |

### 4.5 Money in

| # | Flow | In | Tier | Gate | Freq | Mf |
|---|---|---|---|---|---|---|
| 41 | Raise the invoice | EVT | M | S | hi | 1 |
| 42 | Match it to the client's PO | EVT | M | – | hi | 1 |
| 43 | Get it to the right AP contact or supplier portal | EVT | C | N | hi | 2 |
| 44 | Reconcile incoming payments against invoices | EVT | M | – | hi | 1 |
| 45 | Chase a 30-day overdue account | **STA** | C | N | hi | 1 |
| 46 | Escalate a 60 or 90-day debt | **STA** | C | S | md | 2 |
| 47 | Set up or vary a payment plan | SAY | C | B | lo | 1 |
| 48 | Process a refund or credit note | EVT | M | B | md | 1 |
| 49 | Handle a chargeback or payment dispute | EVT | **A** | S | lo | 1 |
| 50 | Report the weekly cash position | CAL | M | N | md | 1 |
| +107 | Review or increase a credit limit | STA | C | B | md | 1 |
| +108 | Place an account on hold, or release it | **STA** | M | B | md | 2 |
| +109 | Run the month-end statement cycle | CAL | M | N | md | 1 |
| +110 | Resolve a statement dispute or unapplied credit | EVT | C | S | md | 1 |
| +111 | Vary trading terms for an account | SAY | M | B | lo | 1 |
| +112 | Write off bad debt or refer to collections | STA | C | B | lo | 2 |

### 4.6 Money out and supply

| # | Flow | In | Tier | Gate | Freq | Mf |
|---|---|---|---|---|---|---|
| 51 | Raise a purchase order | SAY | M | B | hi | 1 |
| 52 | Approve a supplier invoice against what was received | EVT | M | B | hi | 2 |
| 53 | Run the supplier payment batch | CAL | M | B | md | 1 |
| 54 | Reconcile the bank feed | CAL | M | N | hi | 1 |
| 55 | Process staff expense claims | EVT | M | B | md | 1 |
| 56 | Reorder stock hitting minimum levels | **STA** | M | B | hi | 1 |
| 57 | Run a stocktake or cycle count | CAL | H | N | md | 2 |
| 58 | Chase a late supplier delivery | **STA** | C | N | hi | 1 |
| 59 | Review or renegotiate a supplier agreement | CAL | **A** | B | lo | 1 |
| 60 | Process a return to supplier | EVT | M | N | md | 1 |
| +134 | Verify and correct a supplier's bank details | EVT | M | **B** | lo | 1 |

> **+134 note.** Supplier bank-detail change is the single highest-value fraud target in this list. It gets its own manifest, its own gate, and an out-of-band verification step — never approved from the same channel that requested it.

### 4.7 Catalogue and pricing operations `+ new group`

| # | Flow | In | Tier | Gate | Freq | Mf |
|---|---|---|---|---|---|---|
| +101 | Set up a new product, service or SKU | SAY | M | B | md | 1 |
| +102 | Version and publish a price list or rate card | CAL | M | B | md | 2 |
| +103 | Pass a supplier price increase through to customer rates | EVT | **A** | B | md | 2 |
| +104 | Discontinue or obsolete a product | SAY | M | B | lo | 1 |
| +105 | Set up a customer-specific price agreement | SAY | M | B | md | 1 |
| +106 | Publish or withdraw a promotion | CAL | M | B | md | 1 |

### 4.8 Fulfilment and logistics `+ new group`

| # | Flow | In | Tier | Gate | Freq | Mf |
|---|---|---|---|---|---|---|
| +113 | Pick and pack an order | EVT | H | – | hi | 1 |
| +114 | Book freight or schedule a delivery | EVT | M | N | hi | 2 |
| +115 | Send dispatch notification and tracking | EVT | M | – | hi | 1 |
| +116 | Capture proof of delivery | EVT | M | – | hi | 1 |
| +117 | Handle a delivery exception — damaged, short, failed | EVT | C | S | md | 2 |
| +118 | Process a consumer return or exchange | EVT | M | B | md | 1 |
| +119 | Transfer stock between branches | STA | M | B | md | 1 |

### 4.9 Keeping the client

| # | Flow | In | Tier | Gate | Freq | Mf |
|---|---|---|---|---|---|---|
| 61 | Respond to a complaint | EVT | **A** | S | md | 2 |
| 62 | Triage a support ticket | EVT | C | – | hi | 1 |
| 63 | Answer "where is my order" | EVT | M | – | hi | 1 |
| 64 | Process a warranty claim | EVT | C | S | md | 2 |
| 65 | Ask for a review or testimonial | **STA** | M | N | hi | 1 |
| 66 | Run the post-job satisfaction check | **STA** | M | N | hi | 1 |
| 67 | Reach out to a client quiet for six months | **STA** | C | S | md | 1 |
| 68 | Handle a cancellation and try to save it | EVT | **A** | S | md | 1 |
| 69 | Renew a recurring contract or service agreement | **STA** | C | S | md | 2 |
| 70 | Spot and pitch an upsell | **STA** | **A** | S | md | 1 |

### 4.10 People

| # | Flow | In | Tier | Gate | Freq | Mf |
|---|---|---|---|---|---|---|
| 71 | Write and post a job ad | SAY | C | S | lo | 2 |
| 72 | Screen applications | EVT | C | N | md | 1 |
| 73 | Schedule and run interviews | EVT | H | N | md | 2 |
| 74 | Make the offer and issue the contract | SAY | M | S | lo | 2 |
| 75 | Onboard a starter — accounts, equipment, induction | EVT | M | N | lo | 3 |
| 76 | Run payroll | CAL | M | B | md | **6** |
| 77 | Approve leave requests | EVT | M | B | hi | 1 |
| 78 | Build and adjust the roster | CAL | **A** | B | hi | 2 |
| 79 | Hold a performance conversation | CAL | H | – | lo | 2 |
| 80 | Offboard someone leaving | EVT | M | N | lo | 3 |
| +130 | Track staff ticket and certification expiry | **STA** | M | N | md | 1 |
| +131 | Book and record training | EVT | M | N | md | 1 |

### 4.11 Contractors and external labour `+ new group`

| # | Flow | In | Tier | Gate | Freq | Mf |
|---|---|---|---|---|---|---|
| +126 | Onboard a subcontractor — insurance, licences, terms | EVT | C | B | md | 2 |
| +127 | Verify subcontractor insurance and licence currency | **STA** | M | N | md | 1 |
| +128 | Issue a work order to a subcontractor | EVT | M | S | hi | 1 |
| +129 | Approve a subcontractor claim or invoice | EVT | M | B | hi | 1 |

### 4.12 Assets, fleet and equipment `+ new group`

| # | Flow | In | Tier | Gate | Freq | Mf |
|---|---|---|---|---|---|---|
| +120 | Register a new asset and its warranty | EVT | M | – | md | 1 |
| +121 | Schedule preventive servicing | **STA** | M | N | md | 1 |
| +122 | Book a repair or handle a breakdown | EVT | C | B | md | 1 |
| +123 | Renew vehicle registration or asset compliance | **STA** | M | B | md | 1 |
| +124 | Track asset assignment — who has what | EVT | M | – | md | 1 |
| +125 | Dispose of or write off an asset | SAY | M | B | lo | 1 |

### 4.13 Obligations

| # | Flow | In | Tier | Gate | Freq | Mf |
|---|---|---|---|---|---|---|
| 81 | Lodge the tax return, BAS or VAT | CAL | H | B | md | 3 |
| 82 | Renew insurance policies | **STA** | C | B | lo | 2 |
| 83 | Renew licences, registrations, certifications | **STA** | M | B | md | 2 |
| 84 | Run a safety induction or toolbox talk | CAL | H | N | md | 2 |
| 85 | Report and investigate an incident | EVT | H | B | lo | 3 |
| 86 | Respond to a regulator or auditor request | EVT | **A** | S | lo | 2 |
| 87 | Handle a privacy or data access request | EVT | C | S | lo | 2 |
| 88 | Review and update a policy document | CAL | H | B | lo | 1 |
| 89 | Complete a client's vendor compliance questionnaire | EVT | **A** | S | md | 1 |
| 90 | Archive records to meet retention rules | CAL | M | – | lo | 1 |
| +137 | Track contract milestones and obligations | **STA** | M | N | md | 2 |
| +138 | Process a contract variation | SAY | C | S | md | 1 |
| +139 | Manage retention release or defects-liability expiry | **STA** | M | S | md | 1 |

### 4.14 Running the thing

| # | Flow | In | Tier | Gate | Freq | Mf |
|---|---|---|---|---|---|---|
| 91 | Produce the monthly management report | CAL | C | N | md | 2 |
| 92 | Forecast next quarter's revenue | CAL | **A** | N | lo | 1 |
| 93 | Set and review budgets | CAL | H | B | lo | 1 |
| 94 | Run the leadership meeting and capture actions | CAL | H | – | md | 2 |
| 95 | Review pricing across the whole book | CAL | **A** | B | lo | 1 |
| 96 | Triage an IT or system outage | EVT | C | N | md | 1 |
| 97 | Manage software licences and subscriptions | **STA** | M | B | lo | 2 |
| 98 | Back up and verify critical data | CAL | M | N | lo | 1 |
| 99 | Respond to an RFP or tender | EVT | **A** | S | lo | 3 |
| 100 | Approve a capital purchase | SAY | M | B | lo | 1 |
| +135 | Produce branch-level performance reporting | CAL | M | N | md | 1 |
| +136 | Escalate a decision above local authority limit | EVT | M | B | md | 1 |
| +140 | Publish an internal announcement or policy change | SAY | C | B | md | 1 |

### 4.15 Data and records hygiene `+ new group`

| # | Flow | In | Tier | Gate | Freq | Mf |
|---|---|---|---|---|---|---|
| +132 | Detect and merge duplicate customer records | **STA** | C | B | md | 2 |
| +133 | Update a customer's contact or billing details | SAY | M | N | hi | 1 |

> **+132 is the flow that keeps §8 honest.** The canonical-entity argument in the spec says a CRM's real value is one deduped contact record with a stable ID. That property doesn't maintain itself — it needs a sweeper that finds near-duplicates and a gate that has a human confirm the merge. Without this flow, the canonical store degrades into exactly the mess it exists to prevent.

---

## 5. What the distribution says

Counts are first-pass eyeball classification across 140 flows, not a rigorous audit. Directionally reliable, not exact.

### 5.1 Ingress

| Ingress | Share | Read |
|---|---|---|
| `EVT` external system event | ~35% | Arrives from Xero, Stripe, the website, the phone system, a supplier portal. **No human speaks.** |
| `STA` state threshold / absence | **~6%** (was 23% — see correction below) | Nothing happened and that's the trigger. **No human speaks.** |
| `CAL` calendar | ~17% | Fixed schedule. **No human speaks.** |
| `SAY` human utterance | ~15% | The Kira path. |
| `HUM` human-does-it | ~10% | System preps and captures only. |

**~15% of flows begin with someone saying something.** That is the single most consequential number in this document. It confirms the orchestrator must not be voice-shaped, and it makes the plugin abstraction structural rather than aspirational — voice is one ingress adapter among five, and by volume it is not the largest.

### 5.2 Tier

| Tier | Share | Notes |
|---|---|---|
| `M` mechanical | ~50% | Higher than the spec's 45% prior, because the added logistics/asset/catalogue flows are overwhelmingly deterministic. |
| `C` conversational | ~25% | |
| `A` agentic | ~14% | Clusters almost entirely in quoting, negotiation, complex compliance, and pricing review. |
| `H` assisted | ~11% | **A tier the spec does not currently have.** |

The `H` tier needs to exist explicitly, because if it doesn't, someone eventually writes a manifest for "hold a performance conversation" (79) or "investigate an incident" (85). Naming it makes the denylist a category in the model rather than a note in a document.

### 5.3 Effort versus value — the trap

The ~20 agentic flows will consume most of the engineering. They are also, with the exception of quoting (16) and variations (33), **low frequency**: RFP response (99), vendor questionnaire (89), regulator request (86), supplier renegotiation (59), pricing review (95) — quarterly at best.

Meanwhile ~45 mechanical and conversational flows fire multiple times a week each.

**Build order follows frequency × repeatability, not tier.** This is the spec's own sequencing warning, now with numbers behind it.

---

## 6. The first build — one pattern, twenty flows

> ⚠️ **Correction, 2026-07-27 (eng review).** The `STA` share above was overstated at ~23% and about
> half these rows were misclassified. A **date offset** — "confirm 24 hours out", "licence expiry
> − 30 days", "milestone − N days" — is a `CAL` schedule over a date column by §3's own definition,
> and Zapier/Make/n8n do it trivially. Rows 31, 65, 66, 69, 83, 121, 123, 127, 130, 137, 139 are
> `CAL`. **Genuinely absence-shaped: 9, 19, 22, 26, 45, 46, 58, 67, 132 — nine flows, ~6%.**
>
> The pattern below is still the right first build, and the twenty rows still share one mechanism —
> but the reason is **§15.2 of `EXECUTION_LAYER`: nothing owns these flows today**, not that the
> trigger shape is hard to buy. The competitive argument built on 23% does not survive.
>
> (This heading also said "eighteen flows" over a twenty-row table. It is twenty.)

The highest-value early work isn't the quoting agent. It's a single pattern that recurs across twenty flows and needs no voice, no agent loop, no decomposition and no entity resolution — because the entity is already canonical, having been swept out of Postgres.

> **sweep canonical rows → find those past a threshold → compose a message from a template plus context → apply gate → send**

| Flow | Threshold |
|---|---|
| 19 Quote follow-up | quote sent + 3 / 7 / 14 days, no response |
| 45 Chase 30-day | invoice age > 30 |
| 46 Escalate 60/90 | invoice age > 60 |
| 9 Chase quiet lead | lead last-touched > 14 days |
| 22 Chase signed contract | quote accepted, contract unsigned > 3 days |
| 26 Collect compliance docs | job scheduled, docs missing |
| 31 Confirm appointment | appointment − 24h |
| 56 Reorder stock | on-hand < minimum |
| 58 Chase late supplier | PO promised date passed |
| 65 Ask for a review | job closed + 7 days |
| 66 Post-job satisfaction | job closed + 2 days |
| 67 Reawaken quiet client | last job > 6 months |
| 69 Renew contract | contract end − 60 days |
| 83 Licence / registration expiry | expiry − 30 days |
| 108 Account hold | overdue > threshold and credit limit breached |
| 121 Preventive servicing | hours or date since last service |
| 123 Vehicle rego | expiry − 30 days |
| 127 Subcontractor insurance | policy expiry − 30 days |
| 130 Staff certification | ticket expiry − 30 days |
| 137 Contract milestone | milestone date − N days |

Twenty rows, one mechanism. It exercises the task table, the state machine, the gate machinery and the review queue end-to-end **on real data with zero model in the routing path** — meaning §7 and §8 get validated before a single prompt is written.

It is also the thing a 200-person business notices within a week.

---

## 7. Gates are a delegation schedule, not a per-flow setting

The `Gate` column above is **not** a property of each flow. It is what the portfolio-default delegation policy resolves to for a typical instance of that flow. The model is in spec §7.2.

The organising idea: **what would an executive assistant just do, and what would they come and ask about first?** An EA books a meeting, moves a diary, orders the team's lunch on the company card. They don't book the sales team's flights without asking. That's a delegation of authority — a few bands, applied to classes of action, with limits that widen as trust is earned — and every business of this size already has one, written down or not.

Why it matters at this scale: applied literally, the flat rule *"nothing that leaves the business goes without approval"* catches roughly **35 flows here**, several firing daily. An owner approving every review request (65), satisfaction check (66) and appointment confirmation (31) stops reading the queue inside a week — and an unread queue is worse than no queue, because it launders unreviewed output as approved.

Under the delegation model those land in `notify` because they carry no price and no commitment, while quotes (18), invoices (41), escalations (46) and negotiated discounts (20) still stop and wait. **One tenant policy governs all 140 flows** instead of 140 flows each carrying a copy of the spending rules.

Three cases in this registry that test the model:

| Case | Why it's a test |
|---|---|
| **31, 65, 66, +115** — confirmations, review asks, tracking notifications | High volume, zero risk. If these need approval, the queue dies and everything else dies with it. |
| **+134** supplier bank-detail change | Low volume, catastrophic. Belongs in `reserved` — not delegable at any limit, because the whole attack is convincing someone it's routine. |
| **30, 51, 56** — materials orders, POs, reorders | The spend band does all the work. A $60 top-up and a $60k order are the same flow. |

**Nominated for the `reserved` band** (never delegated at any authority level): **76** payroll disbursement · **81** tax lodgement · **80** termination · **+134** supplier bank details · **+112** bad debt write-off · **100** capital purchase.

Note this is the same list as most of the `H`/assisted tier, arrived at independently — capability and authority converge on the things a business will not hand to an assistant.

---

## 8. What still needs deciding

1. **The starting numbers for the delegation policy (§7)** — the spend bands, the `reserved` list, and whether a tenant may loosen below the portfolio default. The model is agreed; the figures aren't set.
2. **Whether `H`/assisted is a tier or a flag.** Argument for tier: it routes differently and must never execute. Argument for flag: it's a gate of `human_does_the_work`. Recommend tier — it's a routing decision, not an approval decision.
3. **Whether flows 32, 113 and 12** (do the work, pick and pack, gather requirements) belong in the registry at all, or are documented purely as vertical-pack territory. Recommend keeping them listed with `Mf: 0` so provisioning sees the whole picture and knows what the vertical must supply.
4. **Manifest expansion order** — which flows get expanded from flow-level to manifest-level first. Recommend the twenty in §6, then quoting (16, 33), then debtors (45–48, 107–112).
