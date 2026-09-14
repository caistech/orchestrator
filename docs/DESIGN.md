# DESIGN: The Value Gap — Architecture for the Doing Layer

**Owner:** Dennis McMahon, Corporate AI Solutions  
**Date:** 2026-07-29  
**Status:** Locked via /plan-eng-review (2026-09-14) — all architecture + code-quality decisions resolved; implementation task list below  
**Supersedes:** the "radar-only" build order in `ORCHESTRATOR_SPEC.md` §11  
**Companion:** `ORCHESTRATOR_SPEC.md` (the doing-layer spec, deferred) · `VALUATION_LOOP.md` (the workflow) · Kira `lib/genome/` (the 9-area model)

**Review record:** /plan-eng-review walked Step 0 (scope accepted) → Architecture (7 findings: D3-D9) → Code quality (4: D11-D14) → Tests (22 gaps, 3 critical: D16) → Performance (clean, 1 watch item: D17). All rulings are inline at their sections (marked "locked in /plan-eng-review D#"). §9 holds the resolved-decision ledger.

---

## 1. What this document covers

The architecture for closing the gap between *a number on a dashboard* and *the work that moves it*. Specifically:

- The **value gap decomposition**: two legs (continuity / capability), one buyer-lens measure, no double-count
- The **three missing wires**: clarify pass, exec→classify→ingest, SWOT as derived rendering
- The **monotonic admission gate**: static comparable score + dynamic live score, gated at entry, never retired
- The **measured-D**: the orchestrator's running record replacing the questionnaire-derived baseline

Out of scope: the valuation model's arithmetic (already built and correct), the 140-flow registry's internal classification, pricing/subscription mechanics, billing, consent.

---

## 2. The value gap — two legs, one measure

### 2.1 The definition

The value gap has two components, both expressed from a buyer's perspective — *"just how good is my visibility into this business, its drivers, and its weaknesses?"*

**Leg 1 — Continuity (D):** Would this area still perform during one month of the owner's absence at same-or-better effectiveness and efficiency? D = 0 when the owner can walk away and the business does not degrade.

**Leg 2 — Capability (S):** Does this critical function exist at all? Not "it exists but only he runs it" — genuinely absent, never-prioritised functions a buyer's due diligence names.

### 2.2 The partition rule — no double-count

D and S are discriminated by an **existence test**, which the genome's location ladder already encodes:

| Test result | Leg | Example |
|---|---|---|
| Function **exists** but can only be done by the owner | **D** (continuity gap) | "Pricing is entirely in my head" — the function exists, runs through him |
| Function **does not exist** | **S** (capability gap) | No succession plan, no documented safety protocol, no formal financial reporting pack |

**The rule:** a fix can only score on one leg. When a gap is "both" (common — writing the absent SOP usually means someone else can now run it), the classifier assigns it to the leg the buyer names first (continuity). The other leg benefits as a side effect of the same single piece of evidence. One fact, one score.

### 2.3 The overlap picture

```
         VALUE GAP (the number that moves)
┌────────────────────────────────────────────┐
│   D  continuity        S  capability       │
│   "runs only          "function absent"    │
│    through him"                            │
│     ┌──────────────┐                       │
│     │  D ∩ S — the  │                       │
│     │  crossover:   │   S ∖ D — never      │
│     │  the SOP he   │   prioritised, not   │
│  D∖S│  never wrote  │   dependence-related │
│     └──────────────┘                       │
└────────────────────────────────────────────┘
```

- **D ∩ S** (the bulk): SOPs the owner never wrote, meaning both the function is absent AND the owner is the bottleneck.
- **D ∖ S**: functions that exist but run through him (the $220k/£626k plumber case — everything is done, just by him).
- **S ∖ D**: functions absent that are not dependence-related (never prioritised, not because they depend on him but because he never got around to them).

### 2.4 The measure — visibility, not a subjective score

The score is **what fraction of a buyer's diligence can be answered from the record, with evidence.** The two legs feed it differently:

- **D is measured.** The orchestrator's running record of tasks that ran without the owner is the evidence. The 1-month walk-away test is runnable against the record, not a questionnaire.
- **S is assessed.** Against a fixed denominator — the per-area buyer-questions checklist (`lib/genome/checklist.ts`), already built. An `open`/`weak` verdict is an S-gap.

---

## 3. The two-score model

### 3.1 Static comparable score (the headline)

- **Denominator:** frozen at baseline. A `MODEL_VERSION` snapshot of the checklist factors present at signup.
- **Feeds:** the readiness calculation, the quoted multiple, the introducer board.
- **Property:** never re-priced after shown. The "number is sacred" rule (same as `quoted_monthly` lock).
- **Comparable to:** the owner's own baseline. The gap since he signed up.

### 3.2 Dynamic live score (the forward view)

- **Denominator:** the same rubric applied to the *accruing* factor set — the monotonic admission gate's output.
- **Feeds:** the S∖D tail, the Opportunities quadrant, the threat list, the broker conversation.
- **Property:** news, not the number. Never printed in the static score's clothes.

### 3.3 The spread between them

The gap between the static and dynamic scores is itself informative — it's the **emerging best-practice gap**: the distance between what we measured him on at baseline and what the business-of-today demands. A leading indicator.

---

## 4. The monotonic admission gate

### 4.1 The principle

Factors are **never removed** (honesty guarantee: the vendor cannot prune the questions that hold scores down). Admission is gated at entry with a high bar.

### 4.2 Admission

```
doing-layer task / broker challenge / doing-layer surprise
        │
        ▼
   WATCHLIST        ← everything surfaced, nothing admitted yet
        │  absolute floor:
        │   - is this a thing a buyer asks of ANY business in this cohort?
        │   - does it discriminate — real spread, not universally covered?
        │  + v1: OPERATOR sign-off (broker sign-off = v2 requirement,
        │    flagged — there is no broker genome-edit surface today)
        │  + journaled reason
        ▼
   ADMITTED → enters the live factor set, never removed
```

> **V1 sign-off scope (locked in /plan-eng-review D6):** admission is operator-scoped. The introducer channel sees the board but does not edit the genome; the broker-visible admission surface is a v2 feature with no user yet, so it is not built alongside the gate.

### 4.3 Two removal types (the nuance)

| Type | Allowed? | Mechanism |
|---|---|---|
| **Retraction for cause** — wrong specification, wrong cohort | Yes, journaled | Correction, locked to a version. Baseline scores remain readable as what they were |
| **Retirement for coverage** — everyone now answers it | No removal | Flagged *"no longer discriminative"* in a ledger. Stays in denominator. Stops loading the live score only with cohort evidence |

### 4.4 The 140 flows as the founding entrance cohort

`TASK_REGISTRY.md` remains the provenance source: the 9 areas trace to registry sections via `areas.ts` `flowGroups`; the checklist denominator is "that question, itemised." Under monotonic admission, the 140 are the founding entrance batch. Future admissions use the same bottom-up method on live evidence, not the frozen 140.

---

## 5. The seven changes

### 5.1 The clarify pass — the (d) gap

**What:** When the boss gives the EA/CoS a task, that person ensures objectives, responsible tier, critical factors (time, quality, success criteria) are explicit before execution.

**Today:** `DispatchRequest` carries `utterance`, `intentId`, `context`. The seam asks back only for the missing recipient (`needsRecipient`). Nothing else is clarified.

**The change:**

```
incoming dispatch
  → new pre-gate: CLARIFYING
  → orchestrator inspects: is objective explicit? responsible tier known?
    success criteria defined? due time set?
  → if incomplete: returns { status: 'clarifying', missing: [...], prompt: '...' }
  → Kira tool handler asks back
  → re-dispatch with clarified fields
  → proceeds to existing routed → awaiting_approval → etc.
```

**Contract change:** `DispatchRequest` gains optional `clarification` field (re-dispatch with answers); `TaskState` gains `'clarifying'` as a pre-gate state.

**Hard boundary (locked in /plan-eng-review D4):** the task record carries a `clarify_count`; the gate auto-cancels after N rounds (max 2) or the 48h TTL, with a logged reason, surfaced at the owner's next session. The boundary is **structural at the gate, not a convention in Kira's handler** — it survives an adapter swap. An unanswered clarification is worse than a vague dispatch.

**Affected:** `contract.ts` (wire), `app/api/v1/dispatch/route.ts` (orchestrator side — gate enforces count + TTL), `lib/kira/swarm/tool-handlers.ts` (Kira side — `handleDispatchTask`).

**Edge case:** the clarify loop must have a TTL → `cancelled` with reason, surfaced to the owner. An unanswered clarification is worse than a vague dispatch.

---

### 5.2 The exec→classify→ingest wire — the (b)/(f) gap

**What:** A completed task checks against the genome to find where it fits (or nominate for admission if genuinely unique), then ingests as evidence into the SOP component of that area.

**Today:** `derive.ts` classifies *conversation memory* (`kira_memory` → `genome_section`). Nothing classifies completed orchestrator tasks. The two systems are unconnected.

**The change:**

```
task completes (orchestrator)
  │
  ├─ (a) existing: execution + callback to Kira
  │
  ├─ (b) NEW: task carries flowGroup (already provenance in areas.ts)
  │   → callback carries: genomeSection + outcome
  │   → Kira ingests as genome entry with source:'record'
  │
  ├─ (b') NEW: if no genomeSection matches
  │   → nominated to WATCHLIST (not admitted)
  │   → admission gate decides
  │
  └─ (c) NEW: entry lands in area + updates SOP document
         (file-manual re-renders that section)
```

**Contract change:** `TaskEventCallback` gains a typed `genomeMetadata` field carrying `{ flowGroup, genomeSection, outcome }` (not bare `detail` — the shape is validated on both sides). **Resolution ownership (locked in D3): the orchestrator resolves `genomeSection` at emit time** — each `rules.ts` flow carries its `flowGroup` id, and the callback fires pre-classified. Kira stays classification-free on this wire; the orchestrator owns the full task lifecycle, Kira owns the knowledge layer.

**Affected:** `src/rules.ts` (flow→flowGroup), `src/callback.ts` (carry genomeMetadata), Kira `app/api/kira/webhooks/task-events/route.ts` (ingest as evidence), Kira `lib/genome/derive.ts` (accept `source:'record'` entries), Kira `lib/genome/file-manual.ts` (re-render on ingest).

**Async ingest (locked in D8):** the callback inserts the genome entry as **pending** — `source:'record'`, `genome_section: null`, `leg` assigned — then the **existing async classification sweep** classifies it (same pattern the distiller uses for conversation memory). No expensive work runs inside the callback; the orchestrator's fail-soft `notifyCaller` stays fast.

**Deployment order (locked in D9):** Kira ships first with a backwards-compatible handler (accepts both old callbacks with no `genomeMetadata` and new ones), then the orchestrator ships the fields. One-line safe order — prevents the "Kira expects genomeSection, orchestrator hasn't started sending it yet" rollout race.

**The D/S leg tag:** every ingested entry carries `{ leg: D | S | BOTH (flagged), area, buyerQuestion it answers }`. The existence test (§2.2) determines the leg at ingest time.

---

### 5.3 Monotonic admission gate

**What:** When a task surfaces genuinely unique territory (no existing buyer question answers it), it enters the watchlist. The admission gate decides: absolute floor (buyer-critical + discriminating) + v1 operator sign-off (D6: broker is v2), journaled.

**The change:** a new `genome_admission_ledger` table:

```
genome_admission_ledger
  id: uuid
  area_key: text          ← which area this item belongs to
  item_key: text          ← stable id, never renumbered
  buyer_item: text        ← the buyer's phrasing
  owner_prompt: text      ← Kira's agenda phrasing
  factor: text | null     ← which valuation factor this evidences
  admitted_at: timestamptz
  admitted_by: text       ← 'operator' | 'system' (broker admitted_by reserved: v2)
  reason: text            ← journaled: why this item was admitted
  retracted_at: timestamptz | null   ← D12: corrections happen, retirements don't
  retraction_reason: text | null     ← naming matches the only allowed operation
  no_longer_discriminative: boolean default false

  UNIQUE (area_key, item_key)        ← D14: idempotent admission — a second
                                        nomination of the same item updates the
                                        existing row or is rejected as admitted,
                                        never duplicated
```

**Affected:** new migration (with the unique constraint), `lib/genome/checklist.ts` (read admission ledger at score time), `lib/genome/areas.ts` (dynamic area lookup).

---

### 5.4 Two-score storage

**What:** The static score is frozen at baseline; the dynamic score accrues from the live factor set.

**The change:** `business_valuations` gains:

```
readiness_static: number     ← frozen at baseline, never re-computed
readiness_dynamic: number    ← recomputed on admission events
```

The baseline *factor set* is **derived at read time** from `business_valuations.inputs` + the `MODEL_VERSION` lock (D11) — the same function pattern `baseline.ts` already uses, and the same pattern as `readinessPotential` (computed, not stored). No `baseline_factor_snapshot` column: the snapshot is a function of inputs + version, not a second source of truth that can drift from the checklist.

**Affected:** `lib/valuation/model.ts` (dual computation), Kira dashboard pages (two labels, two surfaces), `lib/genome/baseline.ts` (expose the derive-at-read-time function for both scores).

---

### 5.5 Measured-D replacing self-reported-D

**What:** The owner-dependence score moves from questionnaire-derived to measured from the orchestrator's running record.

**Today:** `ownerDependence` is a sub-score map from a pre-signup question (`model.ts`). Self-reported, coarse (3 levels).

**The change:** the orchestrator records, per task, whether it completed **without owner approval** (D5 — the delegation band was `auto` or `notify`; the sweeper never "runs without the owner" by design, so "without the owner" is the wrong lens). D is computed as:

```
D = 1 - (weighted criticality of flows completed without approval
         / weighted criticality of all flows in area)
```

**Criticality weighting (D13):** each flow is weighted by its manifest properties (`blast_radius`, `value_from`, `action_class`) — so a $60k invoice chase out-weighs nine $200 appointment confirmations. The 1-month test answers *"what fraction of the CRITICAL work ran without approval,"* not *"what fraction of all work ran without approval."* Count-based D underestimates the gap when the approval-requiring tasks are the critical ones.

With two quality gates:
- **Effectiveness:** exceptions within tolerance (approval rate holding).
- **Efficiency:** human-touch time falling.

The questionnaire-derived value becomes `source:'baseline'`, superseded the moment measured-D has a full month of data (minimum sample before D is computed from record: see §9; below it, fall back to baseline).

**Affected:** `src/sweeper.ts` (record approval-band + manifest weight on tasks), `lib/valuation/model.ts` (D from record, not questionnaire), Kira `lib/genome/baseline.ts` (labelled as baseline, superseded on measurement).

---

### 5.6 SWOT as derived rendering

**What:** The SWOT is generated from evidence, never self-reported. Each quadrant has a defined generator:

| Quadrant | Generated from | Legs |
|---|---|---|
| **Strengths** | areas banded `covered`, located ≥ `own-cloud` | D∩S resolved + S∖D closed |
| **Weaknesses** | areas `open`/`weak` on buyer questions; location < `reachableByOthers` | the D + S shopfront |
| **Opportunities** | the `moveUp` / `ownerQuestion` offers per area + S∖D tail | what she can offer to do |
| **Threats** | **a rendering of the readiness model's existing shortfalls** (concentration, trend, `weak` with reasons), framed *"what a buyer would flag"* — NOT a separate generator (D7). Same underlying data as the shortfall display, different audience frame. | what a buyer discounts hard |

Each SWOT line carries a row id or a Gate-2 verdict — falsifiable, not opinion. No free-text input into the SWOT. The Threats quadrant must never render data the shortfall display doesn't already surface — one weakness, one screen (the "same weakness twice" failure mode is a regression).

**Affected:** new `lib/genome/swot.ts` (generator), Kira `app/dashboard/page.tsx` (render SWOT panel), `lib/genome/derive.ts` (expose band/location data for SWOT generator).

---

### 5.7 Partition rule enforcement (no double-count regression)

**What:** A single fact cannot move both `ownerDependence` and `systems` sub-scores.

**The change:** every genome entry classified as `source:'record'` is assigned exactly one of `ownerDependence` / `systems` by the existence test (§2.2). A regression test pins this: the same captured fact must not appear in both sub-score feeds.

**Affected:** `lib/genome/derive.ts` (leg assignment at classify time), `lib/valuation/model.ts` (partition check in readiness computation), new test file.

---

## 6. ASCII data flow — the full loop

```
OWNER says something
  │
  ▼
KIRA (voice tool: dispatch_task)
  → handleDispatchTask
  → getSwarmCoordinator().dispatchIntent(...)
  │
  ▼
ORCHESTRATOR  POST /v1/dispatch
  → CLARIFYING gate: objectives? tier? criteria? due? (clarify_count max 2,
    TTL auto-cancel — structural at the gate, survives an adapter swap)
  │   ├─ incomplete → returns { missing: [...] } → Kira asks back
  │   └─ complete ↓
  → QUEUED
  → gate.ts resolves delegation band
  → AWAITING_APPROVAL (if band requires)
  → EXECUTING (sweeper / handler / connector)
  → DONE → notifyCaller POSTs TaskEventCallback
      (D3: orchestrator resolves genomeSection via flowGroup at emit time)
  │
  ▼
KIRA  POST /api/kira/webhooks/task-events
  → upserts kira_tasks (existing: state mirror)
  → NEW: inserts genome entry PENDING — source:'record',
    genome_section:null, leg assigned (D8: no classification in the callback)
  │
  ▼
EXISTING ASYNC SWEEP classifies the pending entry
  │   ├─ genomeSection (orchestrator-sent) confirmed → area
  │   ├─ existence test → leg D or S
  │   ├─ dedupe-sweep (same fact? merge, don't duplicate)
  │   └─ source:'record' — supersedes source:'baseline'
  │
  ▼
GENOME (lib/genome/derive.ts)
  → re-derives OwnerGenome on next page load
  → bands re-computed (checklist-bands.ts)
  → SOP document re-rendered (file-manual.ts)
  → SWOT re-generated (swot.ts)
  → readiness_dynamic re-computed (model.ts)
  │
  ▼
OWNER sees: area improved, score moved, SOP updated, SWOT refreshed
```

---

## 7. Build order

The build follows the human-team metaphor: org structure → SOPs → task list → intake → execute → classify → close → status.

| Phase | What | Acceptance criterion |
|---|---|---|
| **P1** | Clarify pass (`contract.ts` + intake tool handler + TTL) | Dispatch incomplete → returns missing → Kira asks → re-dispatch → proceeds. TTL cancels after N hours. |
| **P2** | Exec→classify→ingest wire (flowGroup on rules, callback carries genomeSection, Kira ingests as `source:'record'`) | Sweeper task completes → genome entry appears in correct area → band re-computed. |
| **P3** | Monotonic admission gate (ledger with unique `(area_key, item_key)` constraint + `retracted_*` columns + watchlist/admission UI; v1 operator sign-off only) | Tester/task discovery → watchlist → operator admission decision → item in live factor set. Journaled. Duplicate nomination updates the existing row, never duplicates. |
| **P4** | Two-score model (static frozen at baseline + dynamic live) | Baseline factor set derived at read time from `inputs` + `MODEL_VERSION` (no snapshot column); dynamic recomputed on admission. Dashboard shows both labels under distinct formats. |
| **P5** | Measured-D (sweeper records approval-band + manifest criticality weight; D from record) | Month of tasks → D computed from record (approved-auto/notify bands, criticality-weighted), not questionnaire. Baseline superseded. Minimum-sample fallback applies below threshold. |
| **P6** | SWOT derivation (generator + dashboard panel; Threats = rendering of existing shortfalls) | Derived from bands + location + admission ledger + shortfall model. No self-report surfaces. Weakness can never appear in two frames. |
| **P7** | Partition rule regression test + anti-double-count guard | Same fact cannot move both sub-scores. Test pinned. |

**Test plan (D16 — 22 acceptance paths across the 7 changes, 3 critical):**
1. **Partition rule regression** (P2/P7) — same captured fact cannot move both `ownerDependence` and `systems` sub-scores.
2. **Static-vs-live score regression** (P4) — the dynamic number never renders in the static (headline) format.
3. **Clarify-loop TTL** (P1) — incomplete dispatch → clarify → count exceeded or TTL → auto-cancel with reason.
All other paths get their acceptance test in the phase that ships them. Tests ship **with** code, never after.

---

## 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Clarify loop becomes naggy | Owner stops using Kira | Hard TTL + max 2 clarification rounds per dispatch |
| Admission gate too strict | Dynamic track starves, no emerging factors | Review after 50 watchlist items; widen if false-negative rate > 20% |
| Admission gate too loose | Junk drawer (the 115-of-233 lesson) | Absolute floor on buyer-criticality + discrimination; operator sign-off journaled (broker review is v2) |
| Measured-D is noisy for small businesses | Score wobbles on few tasks | Minimum sample (N tasks in area) before D computed; below that, fall back to baseline |
| Static score completion (frozen set all green) | Rebase-to-operate conversation forced | Dynamic set is the natural source of new work; rebase is planned, not surprising |
| SWOT generator over-claims strengths | "Covered" band ≠ sale-ready | SWOT carries the band label and the qualifier "completes the document, not the business" |

---

## 9. Open decisions

| # | Decision | Recommendation |
|---|---|---|
| 1 | **Clarify loop TTL** — how long before unanswered → cancelled? | 48 hours; surfaced at next session |
| 2 | **Minimum sample for measured-D** — how many tasks before D computed from record? | 10 tasks in the area over 30 days |
| 4 | **SWOT panel placement** — dashboard or separate page? | Dashboard (below gap figure); too important to hide |

**Decisions locked by /plan-eng-review (2026-09-14, no longer open):**
- **#1 Clarify-loop boundary** → structural: `clarify_count` max 2 + 48h TTL, auto-cancel at the gate (D4).
- **#3 Admission sign-off** → operator-only in v1; broker-visible is a v2 requirement (D6).
- **#5 Dynamic score display** → "What buyers now also ask" vs "Your score" — explicit separation, no shared number format (locked as the D16 static-vs-live regression's invariant).

**Performance watch item (D17):** re-measure `derive.ts` O(items) work on page load when the monotonic factor set passes ~100 admitted factors. Bounded today; not a finding until then.

---

## 10. Implementation tasks (the locked build plan)

**Build order:** T1 → T2 → T3, then T4/T5/T6 can parallelise after T3; T7 closes partition enforcement; T8 is the Kira-only deploy precondition for T2; T9 is Kira-side dashboard work; T10 is the trailing guard.

### T1 — Clarify pass (P1) · **Orchestrator + Kira**
- **Scope:** new `CLARIFYING` pre-gate state; `DispatchRequest` gains optional `clarification` field; gate enforces `clarify_count` (max 2) + 48h TTL → auto-cancel with logged reason; Kira tool handler asks back on `{ status: 'clarifying', missing: [...] }`.
- **Files:** Orchestrator `src/contract.ts` (state + fields), `src/gate.ts` (count/TTL enforcement), `app/api/v1/dispatch/route.ts`; Kira `lib/kira/swarm/tool-handlers.ts` (`handleDispatchTask`).
- **Critical test:** clarify-loop TTL (D16 #3) — incomplete dispatch → clarify → count exceeded / TTL → cancelled with reason, surfaced at next session.
- **Depends on:** nothing.

### T2 — Exec→classify→ingest wire (P2) · **both repos, deployment-ordered**
- **Scope:** `rules.ts` flows carry `flowGroup`; `callback.ts` emits typed `genomeMetadata { flowGroup, genomeSection, outcome }` (D3: orchestrator resolves); Kira webhook inserts pending `source:'record'` entry (`genome_section: null`, leg assigned) — async classification by the existing sweep (D8); deploy Kira first, backwards-compatible, then orchestrator (D9).
- **Files:** Orchestrator `src/rules.ts`, `src/callback.ts`; Kira `app/api/kira/webhooks/task-events/route.ts`, `lib/genome/derive.ts` (accept `source:'record'`), Kira `lib/genome/file-manual.ts` (re-render on ingest).
- **Critical test:** partition-rule regression seeded here (D16 #1) — the leg assigned at ingest cannot feed both sub-scores.
- **Depends on:** T8 (Kira handler deployed first).

### T3 — Monotonic admission gate (P3) · **Kira**
- **Scope:** `genome_admission_ledger` migration with **unique `(area_key, item_key)`** (D14) and `retracted_at`/`retraction_reason` (D12); `admitted_by` restricted to `operator|system` in v1 (D6); watchlist + operator admission UI.
- **Files:** new migration; `lib/genome/checklist.ts` (read ledger at score time), `lib/genome/areas.ts` (dynamic area lookup), admission UI under `app/admin`.
- **Tests:** duplicate nomination → same row updated (idempotent); retraction-for-cause journaled; admission enters live factor set.
- **Depends on:** nothing in T1/T2 (ships independently).

### T4 — Two-score model (P4) · **Kira**
- **Scope:** `readiness_static` (frozen) + `readiness_dynamic`; **baseline factor set derived at read time** from `inputs` + `MODEL_VERSION` — no snapshot column (D11); dual dashboard labels, distinct formats.
- **Files:** `lib/valuation/model.ts` (dual computation), `lib/genome/baseline.ts`, `business_valuations` migration (2 columns), dashboard pages.
- **Critical test:** static-vs-live format invariant (D16 #2) — dynamic number never renders in the static format.
- **Depends on:** T3 (dynamic needs the admission fund).

### T5 — Measured-D (P5) · **Orchestrator + Kira**
- **Scope:** sweeper records **delegation band** (auto/notify = "ran without approval", D5) + **manifest criticality weight** (`blast_radius`, `value_from`, `action_class`; D13); D computed from record, criticality-weighted; questionnaire value becomes `source:'baseline'`, superseded at min-sample (10 tasks/area/30d, §9 #2).
- **Files:** Orchestrator `src/sweeper.ts` (record band + weight), `src/contract.ts` (task outcome carries band); Kira `lib/valuation/model.ts` (D from record), `lib/genome/baseline.ts`.
- **Tests:** month of tasks → weighted D; below min-sample → baseline fallback; single $60k chase outweighs nine $200 confirms.
- **Depends on:** T2 (record data arrives via the wire).

### T6 — SWOT derivation (P6) · **Kira**
- **Scope:** `swot.ts` generator from bands + location + admission ledger; **Threats = rendering of the model's existing shortfalls** (D7) — never a separate generator; dashboard panel.
- **Files:** new `lib/genome/swot.ts`, `lib/genome/derive.ts` (expose bands/location), `app/dashboard/page.tsx`.
- **Tests:** no self-report surfaces; a Weakness item cannot appear in two frames (D7 regression).
- **Depends on:** T3 (admission ledger), T4 (shortfall model).

### T7 — Partition rule enforcement (P7) · **Kira**
- **Scope:** anti-double-count guard on the readiness computation — a `source:'record'` entry feeds exactly one of `ownerDependence`/`systems` by the existence test; pinned regression test.
- **Files:** `lib/valuation/model.ts`, new test file.
- **Tests:** the D16 #1 regression (same fact, both feeds → fail).
- **Depends on:** T2 (source of record entries), T5 (leg data in place).

### T8 — Backwards-compatible callback handler · **Kira only, deploy first**
- **Scope:** `task-events` handler accepts callbacks with **and** without `genomeMetadata` (old orchestrator still in flight); no-classification-in-callback path verified.
- **Files:** Kira `app/api/kira/webhooks/task-events/route.ts`.
- **Tests:** old-style callback → state mirror only (no genome attempt); new-style → pending entry.
- **Depends on:** nothing — the precondition for T2's deploy.

### T9 — Dashboard dual-label + SWOT panel · **Kira**
- **Scope:** static vs dynamic score surfaces with distinct formats; SWOT panel below the gap figure.
- **Files:** Kira dashboard pages.
- **Tests:** label separation invariant (T4's test re-runs here).
- **Depends on:** T4, T6.

### T10 — Trailing guard review · **both repos**
- **Scope:** after P6 ships, re-verify the 22-path acceptance matrix (§7 test plan) in one sweep; confirm build order acceptance criteria.
- **Depends on:** T1–T9.
