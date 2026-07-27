# Admission Tests — the objective framework behind every factor move

**Version** 0.1 — draft for calibration
**Owner** Dennis McMahon, Corporate AI Solutions
**Parent** `VALUATION_LOOP.md` §7 (owner confirms, within an objective framework)
**Implements** Kira `lib/valuation/model.ts` factor levels

> **What this is.** For each level of each readiness factor, the **observable condition that must
> hold before the system is allowed to ask the owner to confirm a move.** No admission test passed →
> no confirmation prompt → no factor movement → no valuation change. The owner confirms a *fact*,
> never an opinion.
>
> ⚠️ **Every threshold below is a v0 proposal, not a calibrated value.** There is no data behind the
> specific numbers — they are chosen to be legible and defensible, and they are expected to move
> after the first cohort. What is *not* provisional is the SHAPE: a measured quantity, a threshold,
> a sustaining window, and a named data source. Calibrate the numbers; keep the shape.

---

## 1. The four rules every test obeys

1. **Measured, not asked.** The quantity comes from system behaviour or connected data. If it can
   only be obtained by asking the owner how they feel, it is not an admission test.
2. **Sustained, not instantaneous.** Every test carries a window. A good fortnight is not a changed
   business, and a factor that moves on a spike will move back.
3. **Volume-floored, so you cannot win by doing less.** Every ratio is paired with an absolute floor
   (§4). Otherwise the fastest route to a high score is to stop giving the system work.
4. **Degrade, don't fake.** No data for a test → the factor **does not move**, and the dashboard says
   *why* it can't move. It never infers, never defaults, never quietly holds a stale pass.

**Confirmation prompt shape** — evidence first, single fact, one tap:

> *"Over the last 8 weeks, 47 of 61 completed tasks ran without you touching them, across 6 of your
> 9 task types. Confirm this is normal operation now, not a quiet patch."*

Every confirmation records: the metric values, the window, the model version, and the raw inputs —
so a buyer's advisor can reconstruct the claim years later (`VALUATION_LOOP.md` §4.1).

---

## 2. Owner dependence — weight 3, system-observable

The heaviest factor and the one that needs no adapter. Two measured quantities plus one event test.

**OUTS — owner-untouched task share.** Completed task instances in the window that finished with
zero owner interaction (no approval, no edit, no manual step, no stall-awaiting-owner) ÷ all
completed task instances in the window.

**Breadth.** Distinct task kinds standing at delegation band `auto` or `notify` ÷ distinct task
kinds active in the window.

**The absence test.** A continuous owner-absence of ≥5 business days (no logins, no approvals, no
task touches) during which **throughput did not fall more than 20%** against the preceding 4-week
mean. This is the single most defensible sellability signal in the whole model — it is what a buyer
actually wants to know, and it is directly observable.

| Move | Admission test | Window |
|---|---|---|
| `i_am_the_business` → `heavily_involved` (0 → 0.33) | OUTS ≥ 25% **and** ≥2 task kinds at auto/notify | 4 consecutive weeks |
| `heavily_involved` → `mostly_runs` (0.33 → 0.7) | OUTS ≥ 60% **and** breadth ≥ 50% **and** no single task kind accounts for >40% of remaining owner touches | 8 consecutive weeks |
| `mostly_runs` → `fully_managed` (0.7 → 1) | OUTS ≥ 85% **and** breadth ≥ 80% **and** **the absence test passed at least once** | 12 consecutive weeks |

**Why the last one needs the absence test.** OUTS and breadth can both be high in a business where
the owner is still the single point of failure — they just haven't been needed *yet*. Only the
absence test distinguishes "runs without the owner" from "hasn't needed the owner lately."

**The delegation policy is the instrument, not a proxy.** An owner who moves from *"show me
everything"* to *"anything under $500, just do it"* has literally reduced their own dependence, and
the system holds that policy versioned, with the trust-ratchet evidence behind every widening.

---

## 3. Systems — weight 2, system-observable

Sources: `kira_knowledge`, `kira_knowledge_chunks`.

**Coverage.** Distinct core operating areas with at least one durably captured, retrievable
procedure. (Core areas are per-tenant, named at onboarding — quoting, scheduling, invoicing,
supplier management, etc. — so coverage is a fraction of a stated denominator, not an open set.)

**Stability.** A procedure counts only once unedited for 30 days. A document still being written is
not yet knowledge.

**Non-owner use.** A retrieval served to, or a task completed by, a principal **other than the
owner**, grounded in captured knowledge.

| Move | Admission test | Window |
|---|---|---|
| `in_my_head` → `some` (0 → 0.5) | ≥3 stable procedures covering ≥1 core area, all retrievable | 30 days stable |
| `some` → `documented_team` (0.5 → 1) | Coverage ≥70% of named core areas **and** ≥1 non-owner use event per covered area | 60 days |

**The non-owner-use test is the heart of it.** Documentation that only its author ever uses is still
functionally in that author's head, and a buyer discovers this within a week of taking over.

⚠️ **Honest limitation: a single-principal tenant cannot reach `documented_team`.** With n=1 there is
no non-owner to serve, so the test is unprovable — and the factor **stops at `some` with that stated
as the reason**, rather than being waved through. This is correct: a business with exactly one person
in it genuinely is less transferable. It also makes `principal_id` load-bearing for the valuation,
not just for authorisation.

---

## 4. Anti-gaming — the volume floor

Every ratio above is gameable by shrinking the denominator. Stop creating tasks and OUTS approaches
100%; stop naming core areas and systems coverage approaches 100%.

**The floor:** no ratio-based test passes if **absolute throughput in the window is below 80% of the
tenant's trailing 12-week mean.** Fewer tasks running is not more independence — it is less evidence,
and it should stall the score rather than raise it.

Also excluded from OUTS: tasks the owner cancelled (cancelling is a touch), and tasks auto-generated
but never actioned (an ignored task is not a delegated one).

---

## 5. Recurring revenue — weight 2, accounting adapter

**Metric:** share of trailing-12-month revenue from customers with ≥3 invoices at regular intervals,
plus any explicitly contracted or repeating invoices.

| Move | Admission test | Window |
|---|---|---|
| `none` → `some` (0 → 0.5) | ≥25% of TTM revenue recurring-patterned | 2 consecutive quarters |
| `some` → `strong` (0.5 → 1) | ≥60% of TTM revenue recurring-patterned | 2 consecutive quarters |

**Unmovable until the accounting adapter connects.** State that on the dashboard; never infer it
from conversation.

---

## 6. Client concentration — weight 1.5, accounting adapter

**Metric:** largest single client's share of TTM revenue, and top-3 combined share.

| Move | Admission test | Cadence |
|---|---|---|
| `concentrated` → `moderate` (0 → 0.5) | Largest <35% **and** top-3 <65% | Evaluated monthly |
| `moderate` → `diversified` (0.5 → 1) | Largest <15% **and** top-3 <40% | Evaluated monthly |

**Monthly, not weekly** — deliberately. This is the factor most prone to jitter as invoice mix
shifts, and a valuation-bearing number that wobbles weekly reads as unreliable. TTM smoothing plus
monthly evaluation is what keeps the line honest.

---

## 7. Growth — weight 1.5, measured but never actioned

⚠️ **Correcting an earlier draft of this doc, which said the ceiling was 85 pre-adapter and 100
post-adapter. Both halves were wrong.** `model.ts:206` computes:

```ts
readinessPotential = Σ (f.capturable ? 1 : f.score) × f.weight / TOTAL_WEIGHT
```

Growth is `capturable: false`, so it contributes **the client's own growth score**, not zero.

**The ceiling is therefore per-client: 85 + up to 15, set by their actual trends** — a business with
strongly growing profit, improving margin and expanding clients has a potential of 100; one in
decline has 85. It is personalised, and it is already computed at baseline from the 3-minute
questionnaire.

**Connecting the accounting adapter does not raise the ceiling.** Growth is deliberately excluded
from the improvable set: the product does not claim to make a business grow, it claims to make it
less owner-dependent and more systematised. What the adapter does for growth is keep the *measured*
value honest — which can move the ceiling **down** as well as up.

| Sub-factor | Levels | Metric |
|---|---|---|
| Profit trend | declining / flat / growing / growing_strongly (0 / 0.4 / 0.75 / 1) | YoY adjusted profit change, TTM vs prior TTM |
| Margin trend | shrinking / stable / improving (0 / 0.5 / 1) | YoY gross-margin percentage-point change |
| Client trend | shrinking / stable / expanding (0 / 0.5 / 1) | YoY active-client count change |

**Growth is the one factor the owner cannot improve by working with us**, and the model already says
so. It carries no improvement action and no uplift — it is measured, reported, and left alone. The
honest framing to the owner is that their growth trend sets *how high the ceiling is*, and our work
is closing the distance to it.

**The ceiling can move under them.** If their trends deteriorate, potential falls and the gap
narrows without anything about their sellability work changing. That must be shown with its reason
attached, or it reads as the system quietly moving the goalposts.

---

## 8. Cadence summary

| Factor | Re-evaluated | Moves on |
|---|---|---|
| Owner dependence | Weekly | Owner confirmation, after admission test passes |
| Systems | Weekly | Owner confirmation, after admission test passes |
| Recurring revenue | Monthly | Adapter data — **no confirmation needed** (it is a fact about their invoices, not about them) |
| Client concentration | Monthly | Adapter data — no confirmation needed |
| Growth | Monthly | Adapter data — no confirmation needed |

**Only the two system-observable factors need owner confirmation**, because only those are
interpretations of behaviour. The three accounting factors are arithmetic over their own invoices —
asking an owner to confirm their largest client is under 35% of revenue would be theatre.

That is a useful split: **the factors the system could plausibly be accused of marking its own
homework on are exactly the ones gated behind a human countersignature.**

---

## 9. What this leaves open

- **Every threshold** — v0, uncalibrated. Expect the first cohort to move them.
- **Core operating areas** (§3) need a per-tenant named list at onboarding, or systems coverage has
  no denominator.
- **The absence test** (§2) requires reliable owner-activity detection across all surfaces, or a
  holiday looks identical to a quiet week.
- **A factor that should move DOWN.** Every test above is written for improvement. If OUTS collapses
  because the owner took back control, does readiness fall — and does the introducer board show it?
  Falling scores are the honest behaviour and the uncomfortable one; the pricing consequence is in
  `VALUATION_LOOP.md` §9 option (c), which is recommended against.
