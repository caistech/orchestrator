# Orchestrator: Interface & Build Spec

**Version** 0.2 — abstracted from the Kira-specific draft
**Owner** Dennis McMahon, Corporate AI Solutions
**Audience** Claude Code (build), Dennis (decisions)
**Companions** `TASK_REGISTRY.md` — the 140-flow seed library this spec routes to · `EXECUTION_LAYER.md` — what happens after the handoff in §5

> ⚠️ **STATUS 2026-07-27: this is DEFERRED ARCHITECTURE, not the current build.**
>
> After `/plan-eng-review` and `/plan-ceo-review`, the build was cut to a **radar** — a watch table,
> a cron, a briefing, a review surface — sold to business owners, referred by accountants and
> brokers. **Kira is not the consumer.** There is no dispatch, no classifier, no plugin contract and
> no voice in the current scope.
>
> This document remains the right design for the doing-layer **if and when the radar validates**.
> Read it as the destination, not the plan. The plan is the CEO plan, rev 3:
> `~/.gstack/projects/orchestrator/ceo-plans/2026-07-27-radar.md`.
>
> Carried forward from here into the actual build: `principal_id` as a column, per-tenant cron
> jitter, the delegation model's *shape* (not its machinery), and the projected-entity-mode
> conclusion in §9.

> **What changed from 0.1.** The 0.1 draft described the seam between Kira and the work getting
> done. Classifying the 100-task business survey showed that **only ~15% of business flows begin
> with someone speaking** — so a voice-shaped contract would have been wrong for 85% of the
> surface. This version treats the orchestrator as a standalone layer and **Kira as one ingress
> plugin among five.** Everything genuinely channel-independent in 0.1 survives verbatim.

---

## 1. What this covers

The seam between *something happening in a business* and *work actually getting done*. Specifically:

- What an ingress plugin emits when there is work to be done
- How that is triaged into **mechanical / conversational / agentic / assisted**
- How existing agents are found and invoked, and what happens when none exists
- How results get back to the owner for approval

Out of scope: the agents themselves, the valuation funnel, ElevenLabs voice config, billing.

---

## 2. The constraint that shapes everything

The original constraint was voice-specific: Kira is a **live conversation in short bursts**, an
agentic task takes 30 seconds to several minutes, and these are incompatible timescales.

Generalised, the constraint is stronger, not weaker: **most work has no human waiting for it at
all.** An invoice ages past 30 days at 2am. A supplier's delivery date passes on a Sunday. A form
submission arrives while everyone is on site.

**Therefore: the orchestrator never blocks a caller that isn't waiting.** For the four non-speech
ingresses it accepts, acknowledges and queues — no exceptions.

> ⚠️ **Corrected 2026-07-27 (eng review).** This previously read *"never runs inline with
> anything."* That was false in two directions: the only live implementation
> (Kira's `LocalSwarmStub`) makes two sequential model calls inside `dispatchIntent` and reads the
> draft back in the same voice turn — and it works. And §5's `answered` / `drafted` dispositions
> mean *ran inline* by definition. **The rule is per-ingress, not global.** `SAY` may produce
> inline under a hard budget with a queued fallback; `EVT`/`STA`/`CAL`/`HUM` never do.
>
> The ~800ms figure below is **asserted, never measured** — and the one implementation that exists
> ignores it. Measure it before letting it shape anything else.

**Latency is a property of the plugin, not the core.** Each ingress declares its own budget:

| Plugin | Budget | Why |
|---|---|---|
| Voice (Kira) | ~800ms | A pause in speech is a failure |
| Chat / Slack | ~3s | A typing indicator covers it |
| Email / webhook | ~30s | Nobody is watching |
| State sweeper / cron | none | No caller exists |

For voice specifically: Kira's dispatch tool returns an acknowledgement, not a result. The owner
hears *"got it — I'll have that quote ready for you to check."* The work happens after. Results
surface in a review queue and are raised at the **start of the next session**.

This is not a limitation to engineer around. It matches the product promise already on the site —
*gets things done, then closes the loop* — and it means the loop closes across sessions, not within
one.

Consequence: **session lifecycle and task lifecycle are separate.** A session is minutes. A task may
live for days. Never model a task as belonging to a session.

---

## 3. Ingress — five classes, not two

The 0.1 draft had two capture paths, and both were "derive a task from something a human said."
The registry survey found five distinct trigger classes. Share is by flow count across the 140-flow
registry.

| Code | Class | Share | Trigger | Example |
|---|---|---|---|---|
| `EVT` | **External system event** | ~35% | Something arrived from another system | Form submission, payment received, inbound call, supplier notification, support ticket |
| `STA` | **State threshold / absence** | **~6%** (was claimed 23% — corrected) | Nothing happened, and that *is* the trigger | Invoice aged past 30 days, lead quiet 14 days, no reply to a quote |
| `CAL` | **Calendar** | ~17% | Fixed schedule | Payroll, month-end, quarterly lodgement |
| `SAY` | **Human utterance** | ~15% | Someone asked, in words | *"Get a quote out to Dave"* |
| `HUM` | **Human-initiated, system-assisted** | ~10% | A person does the work; the system preps and captures | Site visit, interview, incident investigation |

**`STA` is the class the 0.1 draft had no concept of, and it is where the early value is.** See §11
— a single sweep-and-notify pattern covers twenty flows, needs no model in the routing path, and is
the cheapest thing in the system to build.

> ⚠️ **Correction, 2026-07-27 (eng review).** An earlier revision put `STA` at ~23% and used that to
> argue absence-triggers are a differentiator iPaaS handles weakly. **About half those rows were
> misclassified.** A *date offset* — "confirm 24 hours out", "licence expiry − 30 days",
> "contract milestone − N days" — is a **`CAL`** schedule over a date column by this table's own
> definition, and Zapier/Make/n8n do it trivially. Rows 31, 65, 66, 69, 83, 121, 123, 127, 130,
> 137, 139 are `CAL`, not `STA`.
>
> **Genuinely absence-shaped: rows 9, 19, 22, 26, 45, 46, 58, 67, 132 — nine flows, ~6%.** The
> "nothing happened and that's the trigger" insight survives and is still real; the *competitive*
> argument built on 23% does not. The sweep tranche remains the right first build — but because
> nothing owns those flows today (`EXECUTION_LAYER` §15.2), not because the trigger shape is exotic.

### 3.1 The two utterance paths (unchanged, now scoped to `SAY`)

**Path A — explicit dispatch.** The owner says something that is clearly a request; the plugin calls
`dispatch` mid-conversation. Trigger is the plugin's own judgment. Thin payload. Purpose:
acknowledge immediately, queue the work.

**Path B — ambient extraction over a completed artifact.** The full artifact is processed after the
fact. For voice that's the post-call transcript webhook; the same mechanism handles an email thread,
a meeting recording, or a document. Latency budget: seconds to a minute — nobody is waiting. Two
jobs at once:

1. **Genome capture** — knowledge, process, relationships, constraints mentioned in passing
2. **Missed task extraction** — things mentioned that didn't get an explicit dispatch

Path B is where most of the utterance value is. Owners don't speak in clean instructions; they
ramble and mention six things. Path A catches the explicit ones, Path B catches the rest.

**Deduplication is mandatory** — see §5.3. A task dispatched explicitly must not be re-created from
the artifact.

---

## 4. Contracts

The 0.1 draft mixed two contracts together. They are now separate, because a plugin must satisfy
only the first and the core must guarantee only the second.

### 4.1 Core contract — the dispatch envelope

Every ingress plugin emits this. **No field is voice-specific.**

```json
{
  "idempotency_key": "string — REQUIRED, see §4.2",
  "tenant_id": "uuid",
  "principal_id": "uuid — REQUIRED. Whose authority this runs under, see §7.4",
  "plugin_id": "string — which ingress produced this",
  "ingress": "evt | sta | cal | say | hum",
  "captured_at": "iso8601",

  "trigger": {
    "kind": "utterance | system_event | threshold | schedule | human_action",
    "utterance": "string | null — verbatim, when kind=utterance",
    "intent_hint": "string | null — the plugin's one-line reading",
    "event": { "source": "string", "type": "string", "payload": {} },
    "threshold": { "rule_id": "string", "subject_entity_id": "uuid", "breached_value": "any" },
    "schedule": { "rule_id": "string", "scheduled_for": "iso8601" }
  },

  "entities_mentioned": ["string"],
  "entity_refs": ["uuid"],
  "urgency": "now | today | whenever",
  "context_window": "string | null",
  "session_id": "uuid | null"
}
```

Notes on the generalisation:

- **`utterance` moved under `trigger` and is nullable.** A threshold sweep has no utterance and must
  not have to invent one. This was the single most voice-shaped thing in 0.1.
- **`entity_refs` is new and is how the non-speech ingresses avoid resolution entirely.** A sweeper
  already knows it's invoice `INV-1043` — it should not hand the orchestrator the string *"the Dave
  Ellis invoice"* and pay for a fuzzy match. When `entity_refs` is populated, §5 step 1 is skipped.
- **`session_id` is nullable.** Only conversational ingresses have sessions. Reinforces §2's
  separation.
- **`context_window`** is the last ~10 turns for voice, the thread for email, the breaching row plus
  its recent history for a sweep. Cheap, and it's what lets the orchestrator resolve "him" and "that
  job."

### 4.2 Idempotency — required, not optional

Dispatch is fire-and-forget over a network. Retries will duplicate. Every envelope carries an
`idempotency_key`; the core rejects a repeat within a 24-hour window and returns the original
`task_ref`.

Suggested construction by ingress:

| Ingress | Key |
|---|---|
| `SAY` | `hash(tenant, session_id, utterance, captured_at_minute)` |
| `EVT` | the source system's event id, namespaced by source |
| `STA` | `hash(tenant, rule_id, subject_entity_id, threshold_bucket)` — bucket so a daily sweep doesn't re-fire hourly |
| `CAL` | `hash(tenant, rule_id, scheduled_for)` |

This also gives Path A / Path B deduplication for free: post-call extraction reconstructs the same
key as the in-call dispatch and is rejected. The 0.1 draft mandated dedupe with no mechanism.

### 4.3 Plugin contract — what a plugin must provide

A plugin declares which of three roles it fills. Kira fills all three; most plugins won't.

| Role | Obligation |
|---|---|
| **Ingress** | Emit valid envelopes. Authenticate. Declare a latency budget. |
| **Approval surface** | Render a task for review, capture an approval decision, re-read what's being approved before accepting a confirmation |
| **Notification sink** | Receive `task.completed`, `task.failed`, `task.sla_breached` and surface them to the owner |

Splitting these is what makes a Kira voice front-end over a different domain pack possible, and what
lets a tenant run web-review-only with no voice at all.

### 4.4 The Kira binding (plugin #1)

Kira's ElevenLabs server tool is one *binding* of the `SAY` ingress. It is not the core contract.

```json
{
  "name": "dispatch_task",
  "description": "Call this the moment the owner asks for something to be done — a quote, a follow-up, a reminder, chasing an invoice, looking something up. Do not wait until the end of the conversation. Do not try to do the work yourself. Pass what they said in their own words. If you are unsure which client or job they mean, still dispatch and set ambiguous to true.",
  "parameters": {
    "utterance": "string — what the owner said, verbatim or near",
    "intent_hint": "string — your one-line reading of what they want",
    "entities_mentioned": "string[] — names, sites, jobs, amounts as spoken",
    "ambiguous": "boolean",
    "urgency": "now | today | whenever"
  }
}
```

Returns within 800ms: `{ "ack": "Queued — a quote for Dave Ellis.", "task_ref": "tsk_01H..." }`

Kira speaks the `ack` naturally. She does not narrate the `task_ref`.

**Design notes (unchanged from 0.1):**

- No `task_type` parameter. Kira does not classify — the orchestrator does. Kira's job is capture,
  and asking her to also route makes her worse at conversation.
- `utterance` verbatim matters. The orchestrator routes on the raw words as well as the hint, so a
  lossy paraphrase can't silently misroute.
- One tool, not forty. Adding a tool per task type will degrade her conversational quality and
  doesn't scale per-tenant.

**Build on `@caistech/elevenlabs-convai`** for the voice stack — provisioning, webhook routes,
memory loop. Do not re-implement it in this repo.

### 4.5 Routing decision (orchestrator output)

```json
{
  "decision": "route | clarify | unroutable",
  "tasks": [
    {
      "task_type": "quote_nonstandard_job",
      "tier": "agentic",
      "params": { "contact_id": "...", "site_id": "...", "deadline": "..." },
      "unresolved": ["scope_detail"],
      "missing_required": [],
      "entity_candidates": { "contact_id": [{ "id": "...", "score": 0.91 }] },
      "gate": "approve_before_send",
      "gate_reason": { "policy_version": 3, "rule": "client_comms.has_price", "class": "commitment" }
    }
  ],
  "clarify": { "question": "Dave Ellis or Dave Trent?", "options": ["contact_id_a", "contact_id_b"] },
  "unroutable_reason": "string | null"
}
```

`tasks` is an array. One utterance routinely contains three tasks across three tiers.

---

## 5. The orchestrator

**It is a dispatcher, not an agent.** One model call, ends in a handoff. It does not loop and it
does not do work. Every failure here is a total failure, so keep it dumb.

### 5.1 Order of operations (corrected from 0.1)

The 0.1 sequence put entity resolution *after* classification as if both were model steps. Entity
resolution needs database access, so it cannot sit inside the model call. The runnable order is:

1. **Pre-fetch candidates (deterministic).** Fuzzy-match every string in `entities_mentioned`
   against canonical tables. Skip entirely when `entity_refs` is populated — most `EVT`/`STA`/`CAL`
   envelopes already know their subject.
2. **One model call** — decompose the trigger into discrete tasks, classify each against the
   tenant's registry, bind each to a pre-fetched candidate, extract the params each manifest
   requires. All four in one call, given the candidates and the manifest schemas.
3. **Apply gates (deterministic).** From the manifest, resolved against entity attributes — §7.2.
   Never from the model, never from the agent.
4. **Emit** — route, clarify, or log unroutable.

**Decomposition is the hardest step and belongs in the same call as classification** — it's a prompt
concern, not a separate stage. If the orchestrator only ever emits one task, two-thirds of what the
owner said is being dropped.

### 5.2 Routing on structural signals, not confidence scores

The 0.1 draft routed on a model-reported confidence (`>=0.8` route, `0.5–0.8` flag, `<0.5`
clarify). Self-reported LLM confidence is not calibrated — 0.62 does not mean what it appears to
mean, and tuning that threshold tunes a number that doesn't track reality.

Route on facts instead:

| Signal | Decision |
|---|---|
| No `task_type` matched the registry | `unroutable` |
| `missing_required` is non-empty | `clarify` — ask for the missing param specifically |
| Two entity candidates within 0.1 of each other | `clarify` — ask which |
| Zero entity candidates for a required entity | `clarify` |
| Everything bound, nothing missing | `route` |
| Everything bound but the top candidate scored < 0.7 | `route`, flagged in the review queue |

Log the model's confidence anyway — it's useful for calibration analysis. Just don't branch on it.

### 5.3 Dedupe

Idempotency key first (§4.2). Then a secondary semantic check for Path B: within a session, a
candidate task matching an existing task on `task_type` + primary entity + a 6-hour window is
dropped and logged, not created.

### 5.4 Unroutable is a feature

When there's no matching `task_type`, do **not** generate an agent at runtime. Log it with the full
trigger into `unroutable_requests`. That table is the roadmap: it tells you what to build next and
whether dynamic agent generation is a core capability or a rare fallback. Revisit after 200 logged
requests, not before.

Abstracted, this gets better: an unroutable log pooled across plugins and tenants is the
shared-service extraction detector for manifests — it surfaces what to promote into the core library
rather than the vertical pack.

---

## 6. Tiers

Tier is a **property of the task_type in its manifest**, not a runtime judgment. Once you know it's
`quote_nonstandard_job`, it's agentic by definition.

| Tier | Rule | Handling | Share |
|---|---|---|---|
| `mechanical` | Given trigger + data, the correct action is fully determined | Rules engine / scheduler. No model in the path. | ~50% |
| `conversational` | Needs language in or out, but one hop | Single model call, no loop | ~25% |
| `agentic` | Cannot know in advance what info is needed | Agent loop with tools and its own evaluation | ~14% |
| `assisted` | **A human does the work.** System preps, reminds, captures the output. | Never executes. Produces a prompt and a capture surface. | ~11% |

⚠️ **Shares are a first-pass eyeball classification across the 140-flow registry, not an audit**
(corrected 2026-07-27 — an earlier revision of this line claimed "measured, not estimated," which
laundered `TASK_REGISTRY.md` §5's own stated caveat into false precision. Build order, the
build/buy split and the tier model all rest on these numbers; treat them as directional.)

**`assisted` is new in 0.2 and it is a safety feature.** Flows like *hold a performance
conversation*, *investigate an incident*, *run the leadership meeting*, *do the work* must never be
automated. If the tier doesn't exist as a routing category, someone eventually writes a manifest for
one of them. Naming it makes the denylist part of the model rather than a note in a document.

**Effort does not follow value.** The ~20 agentic flows will consume most of the engineering, and
apart from quoting and variations they are quarterly-frequency. The ~45 mechanical and
conversational flows fire multiple times a week each. **Build order follows frequency ×
repeatability, not tier.**

---

## 7. Registry, gates and approval

### 7.1 Registry — three levels of inheritance

`TASK_REGISTRY.md` holds ~140 **flows**, which expand to ~200–260 **manifests**. Keep those levels
distinct: the flow is what a tenant activates and what you sell; the manifest is what the router
resolves to. Expansion is uneven — *take a deposit* is one manifest, *run payroll* is six, *do the
work* is zero and belongs to the vertical.

```
core library          universal — chase_invoice, schedule_followup, confirm_appointment
  └─ vertical pack    trades / healthcare / hire — quote_nonstandard_job, capture_site_photos
       └─ tenant      pricing rules, gate strictness, terminology
```

Manifest shape (unchanged from 0.1, plus conditional gates):

```yaml
task_type: quote_nonstandard_job
tier: agentic
ingress: [say, evt]
entities: [contact, site, job, quote]
required_params: [contact_id, scope_summary]
optional_params: [deadline, site_id]
tools: [past_quotes, material_rates, capacity_check, web_research]

# The manifest describes WHAT THE ACTION IS. It does not decide what needs asking —
# that is the tenant's delegation policy (§7.2), resolved at dispatch.
action_class: [client_comms, commitment]
value_from: quote.total
reversible: false
blast_radius: single_contact

agent_ref: agents/quoting/v3
sla_minutes: 30
```

**Hard rule on inheritance: a downstream layer may only tighten a gate, never loosen it.** A tenant
override must not be able to turn `human_approval_before_send` into `none`. Enforce at manifest
load, not at review.

**Provisioning claim, split honestly.** A new tenant in an *existing vertical* = manifest activation
only, no code. A new *vertical* = manifests plus tools plus agents, because `tools: [material_rates]`
and `agent_ref:` are code references. The 0.1 validation test ("write manifests for two unrelated
businesses and measure how much runtime you touched") will fail as stated and give a false negative
on the whole thesis. Test **two tenants in one vertical** for the activation claim, and accept that
a new vertical costs code.

### 7.2 Gates are delegated authority — the EA model

**The organising idea.** A gate is not a property of a task. It is the answer to a question every
business already answers about a new executive assistant:

> *What can they just do, and what do they come and ask me about first?*

An EA books a meeting, moves a diary, orders the team's lunch on the company card. They do not book
the sales team's flights without asking. Nobody writes that rule per-activity — it's a **delegation
of authority**: a small number of bands, applied to classes of action, with limits that widen as
trust is earned. Every business of the avatar's size has one, written down or not.

This is the right model for agents for three reasons: it is **familiar** (the provisioning
conversation is one an owner has had before), it is **explainable** (*"I didn't book it — it's a
$6,400 irreversible commitment and your limit is $5,000"* is a sentence a human accepts), and it
**scales** (one policy governs 250 manifests instead of 250 manifests each carrying a copy of the
spending rules).

**Correction to 0.2's first draft.** Putting `gate_overrides` inside each manifest was sprawl by
another name — it scatters the tenant's spending policy across hundreds of files, so changing a
limit means editing hundreds. The manifest now declares only **what kind of action this is**; the
tenant holds **one delegation policy**; the orchestrator resolves the two at dispatch.

#### The five bands

| Band | EA equivalent |
|---|---|
| `auto` | Does it, doesn't mention it. Diary invite, order acknowledgement, tracking link. |
| `notify` | Does it, tells you after. *"I confirmed Thursday and moved your 2pm."* |
| `approve_before_send` | Drafts it, shows you. *"Here's the reply to the complaint — okay to send?"* |
| `approve_before_start` | Asks first. *"Do you want me to book the flights?"* |
| `reserved` | **Never delegated at any authority level.** Signing the return, terminating someone, disbursing payroll. |

`reserved` is new and it is what makes the `assisted` tier (§6) enforceable — the same restriction
expressed from the authority side rather than the capability side. A `reserved` action cannot be
un-reserved by raising a limit.

#### The three axes that set the band

- **Value** — what it costs *or concedes*. A discount and a spend are the same axis: both give away
  money.
- **Reversibility** — can this be unwound before it hurts? **This is the sharpest axis and the one
  the EA analogy actually encodes.** An EA books a movable meeting freely and never a non-refundable
  flight. A $2,000 refundable booking is safer than a $200 non-refundable one, so value alone gets
  it wrong.
- **Blast radius** — how many people it touches and whose reputation is on the line. One email to a
  ten-year account is not the same action as a segment blast.

#### Policy shape — one artifact per tenant

```yaml
delegation_policy:
  version: 3
  effective_from: 2026-08-01

  spend:
    - { under: 100,    band: auto }              # team lunch, consumables
    - { under: 1000,   band: notify }
    - { under: 10000,  band: approve_before_start }
    - { else: true,    band: approve_before_start, second_approver: owner }

  discount_or_concession:
    - { under_pct: 5,  band: notify }
    - { else: true,    band: approve_before_start }

  client_comms:
    - { when: { has_price: false, sensitivity: routine }, band: notify }
    - { when: { has_price: true },                        band: approve_before_send }
    - { when: { sensitivity: high },                      band: approve_before_send }

  commitment:
    - { when: { reversible: true, value_under: 5000 },    band: notify }
    - { else: true,                                       band: approve_before_start }

  reserved:
    - payroll_disbursement
    - tax_lodgement
    - employment_termination
    - supplier_bank_detail_change
    - bad_debt_write_off

  overrides:
    quote_nonstandard_job: approve_before_send    # always, regardless of value
```

Resolution at dispatch: take the manifest's `action_class`, evaluate its `value_from` /
`reversible` / `blast_radius` against the matching policy block, take the **strictest** band any
matching class produces, then apply `reserved` and `overrides` last. Record the policy version and
the rule that fired on the task — that record is what makes the explanation in §7.4 possible.

> ⚠️ **Hole found 2026-07-27 (eng review): `overrides` applies LAST and nothing forces it to
> tighten.** `overrides` lives in the tenant policy, not the manifest, so §7.1's tighten-only
> enforcement (which runs at *manifest* load) never sees it. The worked example above happens to
> tighten; the mechanism does not require it. **Fix before Phase 1 ships this shape: an override
> may only produce a band at least as strict as the computed one, validated at policy write, and
> `reserved` is unreachable by any override.** Without that, the entire tighten-only guarantee has
> a documented bypass in the same section that promises it.

This also cleanly handles the dual-channel case that motivated the original conditional gates: a
trade credit note under $500 and a $200k supplier payment batch land in different bands without
either manifest knowing anything about the other.

#### Trust ratchets — how the leash lengthens

A new EA gets a tight leash; six months in they get more rope. Same here, and it is the mechanism
that solves approval fatigue *organically* rather than by decree:

- **Widening from the queue.** After N consecutive approvals of the same manifest at the same band
  with **no edits to the draft**, offer the move down a band: *"You've approved twenty of these
  unchanged — want me to stop asking?"* One click, logged, policy version incremented.
- **Tightening on incident.** A rejected approval, a materially edited draft, a complaint, or a
  failed task raises the band back and states why.

Start every tenant tight. Earned authority is trusted authority; granted authority is not.

### 7.3 The policy is ELICITED by Kira, not configured by the owner

**This is the load-bearing one.** A new executive assistant does not hand their boss a settings form.
They ask — *"what's okay for me to decide, and what do you want to keep for yourself?"* — and they
keep asking, in the flow of the first few weeks, as real situations come up. The delegation policy
is the output of that conversation.

So Kira runs it. Not as a chat-skinned config wizard, but as the thing she is actually best at:
**getting a business owner to say out loud the rules they have never written down.**

This is the strongest available answer to "why voice, when only ~15% of flows start with speech"
(§3). Kira's highest-value job is not dispatch — dispatch is a quarter of the surface and a form
could take most of it. Her highest-value job is **elicitation**: the delegation policy, the entity
genome, the process knowledge, the constraints. Those exist only in the owner's head, a form cannot
get them out, and a conversation can. Dispatch is what she does; elicitation is what she is *for*.

#### She asks for the hour

The first thing Kira does is **ask for the boss's time, and say why**:

> *"Can you give me an hour, boss? I want to make sure I've got the ground rules right — otherwise
> I'll either be asking you about everything, or worse, guessing."*

Three things make this the right opening move, and the first is counterintuitive:

- **The friction is the feature.** Most software tries to be invisible and zero-setup. An assistant
  who asks for an hour so she gets it right reads as *competent*; one who silently starts guessing
  reads as *reckless*. Asking for the time is the trust move, and it sets the expectation that she
  operates within granted authority rather than assumed authority.
- **She books it, she doesn't request it.** *"I've put an hour in Thursday morning — move it if that
  doesn't suit."* This is EA behaviour, and it quietly demonstrates the very thing being negotiated:
  booking a movable meeting is an `auto`-band action, so the first thing she does is show what
  `auto` looks like while discussing what `auto` should mean.
- **She comes prepared.** A good EA doesn't arrive blank. Before the session she reads what's
  already reachable — the flows active for this tenant, whatever the connected systems expose — and
  opens with specifics: *"I've looked at your last fifty purchase orders. Most sit under $2,000 and
  there are eight suppliers you use constantly. Can I just place those, or do you want to see them?"*
  Concrete beats hypothetical, and the difference between this and a config form is entirely in
  whether she did the reading.

**Timebox and resume.** An hour with a business owner will be interrupted. She must be able to stop
at twenty minutes, commit what's settled, and pick the rest up next session — §2's session/task
separation applied to onboarding. The policy-setting task lives across sessions; the session does
not own it.

**The hour produces an artifact worth having.** At the end of it the owner has a written delegation
schedule for their business — which most companies this size do not have, in any form. That is worth
something independent of the product, and it is a strong thing to be able to say in the pitch.

#### Then progressive, not a wizard

The hour settles the ground rules. It cannot settle everything, because nobody knows their own limits
in the abstract — twenty questions gets twenty badly-considered answers. So the hour is followed by
refinement at the moment of use:

1. **In the hour — coarse framing.** *"Roughly what can I spend without checking? Is there anyone
   else who can approve things? Anything you'd never want me touching at all?"* Enough to seed a
   starting policy over the portfolio default.
2. **At first encounter — the good one.** The first time a flow actually fires, ask then, with the
   real thing in hand. *"First quote's ready to go out. Do you want to see these before they send,
   or only the ones over a certain size?"* The question arrives attached to a concrete example,
   which is the only time people answer it well. This is exactly how a real EA learns.
3. **On the ratchet** — the widening and tightening conversations in §7.2.

Consequence for the policy model: it must distinguish **"explicitly set to approve"** from
**"not yet delegated."** Both behave as *ask* at runtime, but only the second triggers the
elicitation prompt. Without that distinction Kira either nags about settled questions or silently
assumes authority nobody granted.

#### Changing the policy is itself `reserved`

Amusing recursion, real requirement: *who approves a change to the approval policy?* Only the owner,
always, at any limit. A delegation change requires an explicit confirmation with a re-read of the
before-and-after — never inferred from *"yeah that's fine"* in the middle of a conversation about
something else. Kira may **propose**; only the owner may **commit**.

#### The policy is a fact, not a memory

`DATA_STANDARD` D1 applies with force here, and this build is unusually exposed to violating it.
Kira is a memory-bearing agent, so the tempting failure is for her to recall *"Dennis is pretty
relaxed about small spends"* and act on the approximation. **The delegation policy is an exact,
auditable, versioned row in Postgres.** Mnemo holds the *conversation* about it — what was said,
when, and why — and never the operative limit.

That split gives an audit trail better than a config log: *"you told me on 3 August that anything
under $500 was fine"*, with the actual utterance behind it.

### 7.4 The output is the Ground Rules — the business's CLAUDE.md

The elicitation session doesn't produce a settings blob. It produces a **standing operating
agreement for the relationship** — the business equivalent of a `CLAUDE.md`. Kira loads it at the
start of every session; it outlives any conversation; the owner can read it, print it, argue with
it, and hand it to a bookkeeper.

The analogy is load-bearing in four ways:

- **Durable and session-independent.** Loaded at the start of every session, not queried at decision
  points. This is §2's session/task separation applied to the relationship itself.
- **Human-readable and owner-editable.** Not a hidden config. If the owner can't read it back and
  recognise their own business in it, the elicitation failed.
- **Accumulates from experience.** The trust ratchet (§7.2) writes into it, and so does every
  incident. Same way a `CLAUDE.md` grows a rule after something goes wrong.
- **Portable.** It belongs to the business, not to the voice layer. Swap the ingress plugin, add a
  second operator, change verticals — the agreement holds.

#### It is wider than authority

This is the part the delegation policy alone misses. A real working agreement carries two registers,
and both belong in one artifact:

| Register | Examples |
|---|---|
| **Hard rules** — binding, enforced in code | Spend bands · `reserved` list · who may approve what · never email non-AU contacts |
| **Operating texture** — judgment, tone, preference | *"CC Sharon on anything touching the Bunnings account." "Don't ring Dave before nine." "Never chase Kev — he always pays, just late." "We don't do fixed-price on heritage jobs."* |

The second register is most of what makes an assistant feel like *theirs* rather than *a system*,
and it is exactly the knowledge that never gets written down anywhere else. It is also, notably, the
kind of thing an owner will volunteer in the hour and would never enter into a form.

#### One document, two layers — and this distinction is not optional

A `CLAUDE.md` is prose read by a model, which interprets it. **The delegation half cannot work that
way.** A model reading *"roughly a hundred bucks is fine"* and deciding what that means is precisely
the `DATA_STANDARD` D1 violation §7.3 warns about, except now it is spending money.

So the Ground Rules **present as one document and store as two**:

| Layer | Store | Read by | Nature |
|---|---|---|---|
| **Hard rules** | Postgres, versioned, exact | The gate resolver — deterministic code, no model | Executable policy |
| **Operating texture** | Mnemo, scoped to the tenant | Kira's context at session start | Interpretive guidance |

The gate resolver never reads prose. Kira never enforces a limit from memory. The document the owner
sees is the join of the two.

#### Delegation is granted by a principal, not by a tenant — RESOLVED

**Locked 2026-07-27. The policy keys on `(tenant, principal)`.**

An EA working for three directors holds three different sets of latitude, keeps them separate, and
escalates to the right one. Nobody would design an assistant who applies the CEO's spending limits to
a request from a junior manager — but a tenant-only policy does exactly that.

**The governing principle, which is not ours and not negotiable:**

> **You cannot delegate authority you do not hold.** A branch manager with a personal $5,000 limit
> cannot grant Kira $20,000.

Without this, the system is an **authority-laundering machine**: *"I couldn't approve it myself, so I
asked Kira to."* That is the first thing an auditor, an insurer or a CFO will probe, and there is no
good answer to it after the fact.

**The chain — tighten-only at every hop**, the same rule as §7.1 extended downward:

```
portfolio default
  └─ tenant policy        (owner-set)
       └─ role ceiling    (owner-set, ≤ tenant)
            └─ principal grant  (≤ role ceiling)
```

Roles seed ceilings so a 200-staff business doesn't need fifteen elicitation sessions — the owner
sets *"branch managers can let Kira go to $2,000"* once, and an individual manager may tighten within
it, never exceed it. The *grant* stays personal, because the elicitation conversation happens with a
person, not a role.

**Two consequences that are easy to miss:**

- **System-triggered tasks need a principal too.** A `STA` sweep fires at 2am and nobody spoke. The
  **rule** carries the authority: every sweep and schedule rule has an `on_behalf_of` principal —
  whoever activated that flow, defaulting to the owner.
- **Escalation follows the chain, not the org chart shortcut.** A branch manager's task exceeding
  their band escalates to *their* approver, not automatically to the owner. This is what stops the
  review queue becoming a single overflowing inbox belonging to one person.

**Carried on every record from day one:** `principal_id` on the envelope, the task, the sweep rule
and the approval. **Even while v1 has exactly one principal and it is always the owner** — the column
costs nothing now and cannot be recovered later. Specifically: historical tasks with no principal can
never answer *"under whose authority did this run?"*, and past approvals become unreconstructable,
because whether an approver was *entitled* to approve is derived from a policy that had no principal
dimension at the time. That is an audit hole no later migration can close.

#### Ground Rules are not the Business Genome

Keep these separate — they are elicited in the same conversations and stored differently:

- **Business Genome** — what is *true* about the business. Clients, jobs, processes, constraints.
- **Ground Rules** — how *we work together*. Authority, preferences, escalation, tone.

One is knowledge, the other is agreement. Conflating them means an operating rule gets recalled
semantically alongside a fact about a client, and neither is then reliable.

#### It rots, so it gets re-read

A working agreement edited twenty times without review is not an agreement. Registry flow 88 —
*review and update a policy document* — applies to this document, on a schedule, with Kira raising
it: *"we set these limits eight months ago and I've widened four of them since. Worth ten minutes?"*

---

### 7.5 What survives from the hard rule

**Nothing carrying a price, a commitment, or a legal position leaves the business without explicit
approval** — still true, but now it is a *consequence* of the policy rather than a rule bolted on
top. The default policy places all three in `approve_before_send` or stricter, and a tenant may only
loosen within bands the portfolio default permits. `reserved` cannot be loosened at all.

This is what fixes the volume problem the flat rule created. ~35 registry flows produce outbound
client communication and several fire daily; under the flat rule an owner approves every appointment
confirmation and satisfaction check, stops reading the queue inside a week, and an unread queue is
worse than no queue because it launders unreviewed output as approved. Under the delegation model
those land in `notify` because they carry no price and no commitment — while the quote, the invoice
and the negotiated discount still stop and wait.

**Approval UX:** review queue in the web app, plus the notification sink raising open items at the
start of the next session (*"that quote for Dave's ready — want me to send it?"*). **The voice
approval path needs a re-read of what's being approved; do not let "yeah send it" fire on an
unreviewed draft.** For `approve_before_start` items the re-read must state the consequence and the
band that triggered it, matching the `PRODUCT_STANDARDS` §9 consequence-clarity codicil.

---

## 8. Task lifecycle

The 0.1 draft had gates implying states but never enumerated them, which means Phase 1 would ship a
task table that Phase 6 rewrites.

```
queued → routed ─┬→ awaiting_start_approval → running
                 └→ running → awaiting_send_approval → approved → executing → completed
                            └→ completed
any → failed · cancelled · superseded
routed → clarifying → routed
```

| State | Meaning |
|---|---|
| `queued` | Envelope accepted, not yet routed |
| `clarifying` | Waiting on a human answer to an ambiguity |
| `routed` | Bound to a task_type with params |
| `awaiting_start_approval` | Gate `B` — not begun |
| `running` | Handler executing |
| `awaiting_send_approval` | Gate `S` — draft produced, held |
| `approved` | Human said go |
| `executing` | Post-approval action in flight |
| `completed` / `failed` / `cancelled` / `superseded` | Terminal |

Rules: transitions are append-only with actor and timestamp; only a human actor may enter
`approved`; `unroutable` is a terminal state on the envelope, not a task state.

> ⚠️ **Three holes found 2026-07-27 (eng review), all mine:**
> - **`clarifying` has no timeout and no terminal path.** A task whose clarify question is never
>   answered sits there forever. Needs a TTL → `cancelled` with a reason, surfaced to the owner.
> - **`superseded` has no rule that produces it.** It appears in the terminal set and nothing
>   transitions into it. Either define the producer (a newer draft version supersedes an older
>   pending one) or delete the state.
> - **"only a human actor may enter `approved`" is a convention, not a control.** Handlers run with
>   service credentials against the same Postgres. For a design whose pitch is *structurally, not
>   behaviourally, true*, this is the one place it is behavioural. Enforce at the DB (a trigger
>   refusing `approved` without an `approvals` row) or stop claiming it is structural.

### 8.1 SLA and failure surfacing

`sla_minutes` exists in the manifest and 0.1 never used it. **§13 names silent failure as the top
risk, so this needs a mechanism, not a note.**

A sweeper runs every N minutes over non-terminal tasks. On breach it emits `task.sla_breached` to
the tenant's notification sinks. Failed tasks emit `task.failed`. Both must reach the owner at the
next session — a task Kira acknowledged and then dropped silently is worse than her saying she
couldn't do it.

### 8.2 Cost and concurrency caps

Not in 0.1, and non-negotiable against the monetisation rails (R12 no uncovered cost exposure, R14
hard-cut not soft-warn). Agentic loops spend tokens on a tenant's behalf, and the orchestrator is
the only place a cap can live.

Per tenant: a concurrency ceiling on running agentic tasks, and a rolling spend cap that warns at
80% and **hard-stops at 100%** — new agentic dispatches queue as `awaiting_capacity` rather than
executing. **Consume `@caistech/beta-gate`** (trial clock + `costCap` + soft-warn band); do not
build a second one.

---

## 9. Data layer

### The entity layer — an index, not a system of record

**Locked 2026-07-27: we do not replace a tool the business already uses. We integrate with what is
there, and we build only where nothing is.** This reshapes the entity layer more than any other
decision in the document, and it supersedes 0.1's *"this is the part that replaces a CRM."*

A business of the avatar's size already runs Xero, and probably Simpro or ServiceM8 or similar. Those
systems own the contacts, jobs, quotes and invoices, and they own them well. Insisting on being the
system of record turns every conversation — with an owner *and* with a distributor — into a
rip-and-replace conversation, which is the hardest sale there is and the least defensible position to
hold.

#### Two modes, and *projected* is the default

| Mode | When | Who is canonical |
|---|---|---|
| **Projected** (default) | A tool already owns these records | **Their system.** We hold an index, not a copy. |
| **Authoritative** (fallback) | Nothing owns them — the common case for compliance documents, certificate expiries, contract obligations, follow-up state, and the delegation policy itself | Us, because nobody else is holding it. |

Same interface either way; handlers do not know or care which mode an entity is in.

#### What the index actually holds

Thin, and deliberately so. The orchestrator needs exactly four things per entity:

1. **A stable local id** to attach tasks and effects to
2. **Resolution attributes** — name, aliases, email, phone — enough to turn *"Dave Ellis"* into that id
3. **Gate attributes** — `account_type`, value bands — enough for §7.2 to resolve a band
4. **Sweep attributes** — `days_overdue`, `last_contacted_at`, `expires_on` — enough for a threshold rule to fire

Plus a pointer home: `source_system`, `source_id`, `synced_at`. That is an **entity index**, not a
CRM, and it is two tables rather than fourteen.

Separately, the system owns its **own operational records** absolutely, because nobody else does:
`tasks`, `task_events`, `effects`, `drafts`, `approvals`, `delegation_policy`, `ground_rules`,
`sessions`, `unroutable_requests`.

> **The line: we own our own records completely, and nobody else's business records at all.**

#### Detection versus decision — the rule that keeps a projection safe

A projection is stale the moment it is written, and the failure this creates is concrete: chasing an
invoice the client paid this morning.

> **Sweep the projection to find candidates. Confirm against the system of record before emitting an
> effect.**

The projection is for **detection**; the source is for **decision**. This costs one API call at the
point where it matters and removes the entire class of embarrassing-because-stale actions. Where the
source cannot be reached, the task fails to the review queue with the reason — degrade, don't fake
(`DATA_STANDARD` R4).

#### What still holds from 0.1

**Entities belong to the tenant, not to a plugin.** If two plugins each maintain their own view of a
contact you have rebuilt the failure this layer exists to prevent — regardless of who is canonical
underneath. This remains the strongest single argument for the abstraction.

And identity discipline still matters: three agents writing three versions of the same client is a
real failure whether the records live here or in Xero. In projected mode, registry flow +132 (detect
and merge duplicates) *proposes* merges into the source system rather than performing them locally.

### Context and knowledge → Mnemo / Business Genome

Conversation history, distillations, process knowledge, the narrative around entities. Every chunk
carries a `subject_entity_id` pointing at a canonical row wherever one exists.

### Retrieval pattern

Agents **resolve to a canonical entity first, then pull context against it.** Never semantic-search
for a client.

### Conflict rule — already decided by portfolio canon

> **Postgres is authoritative for anything with an ID. Mnemo is authoritative for anything with a
> narrative.** On conflict, Postgres wins for entity facts; Mnemo wins for "what was said and when".
> Never write the same fact to both as the source of truth.

This is not an open decision — it is `DATA_STANDARD.md` D1/D3 restated: STRUCTURED for exact,
auditable, canonical values; Mnemo for experiential and interpretive memory. The 0.1 proposal
matches canon exactly. **Confirmed, not pending.**

Two sources of truth is zero sources of truth, and that bug surfaces late and expensively.

---

## 10. Plugin boundary

A plugin declares which roles it fills (§4.3). Three separable things that Kira happens to bundle:

| Plugin type | Provides | Examples |
|---|---|---|
| **Ingress adapter** | Envelopes | Kira voice · inbox · Xero/Stripe webhooks · state sweeper · cron |
| **Domain pack** | Entity schema, manifests, domain tools | Trades · healthcare · equipment hire |
| **Approval surface** | Review UI, approval capture, notification sink | Kira voice · web queue · Slack |

Bundling them prevents the combinations you will want: a Kira front-end over an accountancy domain
pack, or a web-review-only tenant with no voice.

**Plugin #2 should be a second ingress into the same tenant, not a second product** — the state
sweeper or a Xero webhook adapter. Same entities, same registry, same gates, same queue. If the core
contract survives an adapter that never populates `trigger.utterance`, the abstraction is real. That
test costs an afternoon; a second vertical costs a quarter.

---

## 11. Build sequence

Each phase ships something testable. Do not start the next until the acceptance criterion passes.

**Re-ordered in 0.2.** The state sweeper moved ahead of the classifier, because it exercises the
task table, state machine, gate machinery and review queue end-to-end **with no model in the routing
path** — validating §7, §8 and §9 before a single prompt is written. It is also the work a
200-person business notices within a week.

### Phase 1 — Envelope, queue, state machine
Dispatch endpoint, idempotency, task table with the §8 states, ack response, tenant auth. No routing
— everything lands as `unroutable`.
**Accept:** an envelope from any ingress acks within its declared budget, a task row appears with
correct tenant and plugin, and a duplicate key returns the original `task_ref`.

### Phase 2 — State sweeper and the gate machinery
Threshold rules over canonical rows, template composition, gates, review queue, approval capture.
Twenty flows from `TASK_REGISTRY.md` §6 (invoice aging, quote follow-up, expiries, reorder points).
**Accept:** an aged invoice produces a drafted chase, held at its gate, approved in the queue, and
sent — with the whole path visible in `task_events`.

### Phase 3 — Registry, classifier and decomposition
Manifest loader with the three-level inheritance, gate-tighten-only enforcement, classification and
decomposition in one model call, structural routing signals.
**Accept:** 20 real utterances route to the right task_type ≥80% of the time, **and** a three-request
rambling utterance yields three tasks. *(0.1 split these into Phases 2 and 4; decomposition is a
prompt concern in the same call, and deferring it means the ≥80% is measured on unrealistically
clean single-task inputs.)*

### Phase 4 — Entity resolution and clarify
Candidate pre-fetch, ambiguity detection, clarify round-trip through the originating plugin.
**Accept:** two similarly-named clients produce a spoken question, not a coin flip.

### Phase 5 — Execution tiers
Conversational handler (single call), one real agentic loop (quoting), assisted-tier prep-and-capture
surface. Mechanical is already live from Phase 2.
**Accept:** all four tiers complete end to end on real data.

### Phase 6 — Ambient extraction
Artifact webhook (post-call transcript first), Genome capture, missed-task extraction, dedupe against
explicit dispatches.
**Accept:** a task mentioned but not dispatched explicitly appears afterwards, exactly once.

### Phase 7 — Second ingress plugin
A non-speech adapter — sweeper generalisation or an accounting webhook — proving the core contract
holds without `trigger.utterance`.
**Accept:** an envelope with `trigger.kind: system_event` routes, gates and completes with zero
changes to core.

**Sequencing warning (0.1, still true and now quantified):** the ~20 agentic flows will consume most
of the engineering while ~45 mechanical and conversational ones deliver most of the early value.
Don't spend six months on quoting while the owner is still chasing debtors by hand.

---

## 12. Decisions needed from Dennis

Two of the 0.1 decisions are now closed. Five open.

| # | Decision | Status |
|---|---|---|
| 1 | **Conflict rule** — Postgres/Mnemo split | ✅ **Closed.** Already canon — `DATA_STANDARD.md` D1/D3. The 0.1 proposal matches it. |
| 5 | **Dynamic agent generation deferred behind the unroutable log** | ✅ **Closed** unless you object — recommend confirming as stated. |
| 2 | **Registry provisioning** — does Connexions own per-tenant manifest activation, or is this new? | 🔴 Open |
| 3 | **Voice approval depth** — is spoken approval sufficient for outbound client comms? | 🔴 Open. Recommend: web review for anything with a price on it; voice approval acceptable for no-price/no-commitment items after re-read. Matches §7.3. |
| 4 | **Tier escape hatch** — when a mechanical task hits an exception needing judgment, does it fail to the review queue or promote to agentic? | 🔴 Open. Recommend fail-to-queue initially; promotion hides problems. |
| 6 | **Delegation model** — gates as an EA-style authority schedule (§7.2) rather than per-manifest rules | 🟡 **Agreed in principle, needs numbers.** Blocking for Phase 2. What's needed: the starting bands for the portfolio default (the `under: 100 / 1000 / 10000` figures), the `reserved` list, and whether trust-ratchet widening ships in Phase 2 or later. Recommend: default policy in Phase 2, ratchet in Phase 5. |
| 7 | **Plugin roles — three types or one type with capability flags?** | 🔴 **New.** Recommend one plugin type declaring which of the three roles it fills (§4.3). Kira declares all three. |
| 8 | **Can a tenant loosen below the portfolio default?** | 🔴 **New.** Recommend no for `reserved`, yes within bands elsewhere but logged and versioned. This is the same shape as §7.1's gate-tighten-only rule, one level up. |
| 9 | Is delegation keyed on (tenant, principal) or tenant alone? | ✅ **Closed — `(tenant, principal)`.** Chain: portfolio default → tenant → role ceiling → principal grant, tighten-only. `principal_id` carried on envelope, task, sweep rule and approval from day one even at n=1 principal. Sweep and schedule rules carry `on_behalf_of`. §7.4. |
| 10 | **Does the "explicitly set to ask" vs "not yet delegated" distinction ship in Phase 2?** | 🔴 **New.** Both behave as *ask* at runtime, but only the second should trigger an elicitation prompt — without it Kira nags about settled questions or assumes ungranted authority. Recommend yes; it's one column and the elicitation loop depends on it. |

---

## 13. Known risks

- **Distillation loss** — the orchestrator routes on a summary. Mitigated by passing the verbatim
  trigger plus context window, but this remains the most likely source of silent misrouting on the
  `SAY` path. Note it applies *only* to `SAY` — the other four ingresses carry structured triggers,
  which is a further argument for building them first.
- **Tier boundary instability** — tasks that look mechanical have exceptions. See decision 4.
- **Registry sprawl** — ~250 manifests per vertical across many tenants becomes unmanageable without
  the three-level inheritance in §7.1. Design for it from the start, not after.
- **Ack honesty** — acknowledging work that later fails silently is worse than saying it can't be
  done. Mitigated by §8.1, which must ship with Phase 1, not Phase 6.
- **Approval fatigue** — a queue nobody reads launders unreviewed output as approved, which is a
  worse failure than no queue at all. Mitigated by the delegation model (§7.2), which puts routine
  no-price outbound in `notify` and lets limits widen as trust is earned rather than requiring an
  owner to approve appointment confirmations forever.
- **Delegation drift** — the inverse risk the ratchet introduces. Authority that only ever widens
  ends up unbounded, and a policy edited twenty times without review is not a policy. Mitigation:
  every widening is versioned with the evidence that triggered it, `reserved` is immovable, and the
  policy gets a periodic re-read — registry flow 88 (review and update a policy document) applied to
  the system's own delegation schedule.
- **Premature abstraction** — building a plugin framework with one real consumer produces a
  framework shaped like that consumer. Mitigated by Phase 7 landing early enough to correct the
  contract, and by §10's "second ingress, not second product" test.
