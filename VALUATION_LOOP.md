# Valuation Loop — the advisor→client→score workflow

**Version** 0.1 — recovered, not re-derived
**Owner** Dennis McMahon, Corporate AI Solutions
**Companions** `~/.gstack/projects/orchestrator/ceo-plans/2026-07-27-radar.md` (the radar plan this
supersedes in part) · Kira `docs/BROKER_CHANNEL_BUILD_STATE.md` (where most of this is already built)

> ⚠️ **Recovery note.** This workflow was laid out on 2026-07-27 at 01:11 UTC and refined at 01:23,
> after the last file write of that session (00:53). It was never written to disk — it survived only
> in the session transcript and was recovered from it on 2026-07-27. Everything below is transcribed
> from that session; Kira-side claims were re-verified against the repo before being written here.
>
> **It postdates the radar CEO plan and changes it.** The radar plan declares Kira coupling out of
> scope. This workflow puts Kira back at the centre, and the reasoning for that reversal is in §5.

---

## 1. The workflow, as stated

Restated and extended 2026-07-27 (supersedes the 01:11 version — note the **reordering** at steps
3–4, which is a deliberate improvement, see §1.1):

```
demo to advisor
  → advisor refers client to us
  → CLIENT DOES THE 3-MINUTE VALUATION FLOW ON THE KIRA SITE
  → WE DEMO TO THE CLIENT USING THEIR OWN VALUATION GAP DATA
  → client signs up, card at signing, 30-day end-of-month payment, cancel anytime
  → system calculates a BASELINE SCORE for the business/owner,
    from "it's all me" → hands-off sellable business (max)
    [0–100 scale, for scope for nuance]
  → client works with the system
  → system dynamically scores against a dashboard time-based chart
    (combination of OWNER scores + SYSTEM OBJECTIVE MEASURE scores)
  → when the score hits max or near it, THE ADVISOR CAN RE-CHECK WITH THE OWNER ON SALE
  → even though the sellability process is complete, the system should be valuable
    enough that the owner keeps using it — possibly REBASE THE PRICING at that point
```

**The rubric, as specified:** *maximum sellability looks like "this"; baseline is a measurement
against that; the goal is achieved when the rubric measures maximum sellability.*

### 1.1 Why the reordering matters

The earlier version was *demo to client → client runs the valuation*. It is now *client runs the
valuation → demo to client using their gap data*. This is strictly better and it fixes a known
weakness in the radar plan, where "Artifact 2 — client" had to be built before their data existed.
The demo now runs on the client's own numbers from the first minute, which is the whole reason it
lands.

**Resolved 2026-07-27 — there is no unattended step.** The valuation **is the first three minutes of
every client demo**, whether or not they already ran it. If they haven't, it produces the data the
rest of the demo runs on. If they have, walking them through it again adds value rather than
repeating — the numbers mean more narrated than self-served. Attribution is already handled: the
client arrives through the introducer's `/r/[token]` link, first-touch, 90-day window, so the
valuation is attributed before signup either way.

---

## 2. The rubric already exists in Kira

The single most important finding: **the rubric did not need designing.** `lib/valuation/model.ts`
is an SDE-basis valuation calibrated on BizBuySell 2025 data (9,500+ closed deals), with sector
multiples, a floor (owner-dependent, ~half sector average) and a ceiling (fully systemised, capped
at 8× SDE).

```
applied = floor + readiness × (ceiling − floor)
```

`readiness` **is** the rubric, already weighted:

| Driver | Weight | Capturable? |
|---|---|---|
| Owner dependence | 3 | ✅ |
| Systems | 2 | ✅ |
| Recurring revenue | 2 | ✅ |
| Client concentration | 1.5 | ✅ |
| Growth | 1.5 | ❌ financials only |

Weights sum to 10, so readiness is a 0–1 score. Each capturable factor carries a costed `uplift` and
a `reason`, and they sum to the gap.

**The specification maps exactly onto what is already implemented:** maximum = `readinessPotential`
(all capturable factors at 1) · baseline = `readiness` at signup · **goal = gap → 0.** The product
has a completion condition expressed in code.

**Pricing** (`lib/valuation/pricing.ts`): five bands by gap magnitude — **$499 / $999 / $1,999 /
$3,499 / $4,999** monthly — plus `fractionOfGap` and a `fractionWorthQuoting` flag that suppresses
the "small fraction" pitch when the fraction isn't flattering. 30-day trial, card at signup, no
invoice until day 30. The strategy in one line, from `faq.ts`: *"a price stated without the gap it is
a fraction of is just a number to flinch at."*

**So the answer to "why can't this be our pricing model" is: there is no reason. It already is.**

---

## 3. Commission — RESOLVED 2026-07-27

**10% of subscription, trailing.** The `$155` figure was a **placeholder for a theoretical sum** and
carries no weight. The locked Kira build-state decision stands unchanged: 10% of subscription, paid
monthly on collected funds only, lifetime of subscription, trial month pays nothing.

At the price bands that is **$49.90 / $99.90 / $199.90 / $349.90 / $499.90** per client per month.

**One residual copy problem.** *"It won't move your revenue"* is defensible at the low bands (ten
entry-tier clients = $499/month) and false at the high ones (ten Scale-tier clients = $4,999/month).
The sentence is true of a typical book and untrue of a good one — so it should be framed against the
band the advisor's clients will actually land in, or replaced with the more honest version:

> *"We're not going to pretend this is charity. It's 10% for as long as they stay. But we think
> you'll do it a second time because your clients get better, not because of the cheque."*

---

## 4. Build status against the workflow

| Step | Status |
|---|---|
| Client runs valuation, sees gap | ✅ Exists |
| Card at signup, 30-day trial | ✅ Exists |
| Baseline sellability score | ✅ Exists (`readiness`) |
| Rubric with defined maximum | ✅ Exists (`readinessPotential`) |
| Advisor role, referral, attribution, commission, opt-out | ✅ **Shipped** — PR #22 merged, migrations applied |
| Improvement recommendations toward valuation | 🟡 Half — factors carry `uplift` + `reason` and there is a `shortfalls` filter, but nothing turns them into actions |
| **Score updates over the interaction period** | ❌ **Blocked** — see §4.1 |
| Radar / watch items feeding the score | ❌ Missing |
| Xero and other adapters | ❌ Not built — downstream of this layer by design, not missing from it |

Shipped on the advisor side: `introducers`, `introducer_magic_links` (SHA-256 hashed),
`introductions`, `attribution_overrides`, the first-touch immutability trigger verified against the
live DB, `/r/[token]`, `/introducer/enter/[token]`, the `/introducer` board, invite flow,
`/admin/introducers`, and `@caistech/subscription-billing` + `attribution` +
`coordination-sdk@0.4.1` wired.

Still open on their own list: **Workstream D — the commission ledger** (RCTI self-billing, monthly
payout run, per-introducer statement, reconciliation against Stripe collected revenue), C4
co-branded report, C5 introducer email v1. Plus `EMAIL_SENDER_*` unset (mail ships with no Spam Act
footer), production Stripe still on a test key, and a standing guardrail to have a lawyer review the
introducer agreement and disclosure wording.

### 4.1 A shipped defect — the introducer board promises what the schema can't deliver

`introducer_owner_projection()` does:

```sql
LEFT JOIN business_valuations v ON v.user_id = i.owner_user_id
```

with `business_valuations_user_uniq` on `(user_id)` (verified —
`supabase/migrations/20260724000000_business_valuations.sql:28`), and the only writer being
`app/api/onboarding/complete/route.ts` doing an `.upsert()`.

The function's own comment says it returns *"status + valuation movement, never content."* It
returns `valuation_gap`, `valuation_today`, `readiness`, `valuation_at` — **one row, overwritten in
place.** `valuation_at` is `v.updated_at`, which tells an introducer *when it last changed*, never
*what it changed from*. Two visits three months apart show different figures with no way to know it
moved, by how much, or in which direction.

**This is live.** It reframes "add valuation history" from a nice-to-have chart into *making an
existing production promise true.*

**A constraint the code teaches:** there is a deliberate note that re-weighting the model is unsafe
because it *"would re-price valuations already shown to people."* With history that gets worse — a
model change would retroactively rewrite everyone's climb. So snapshots must record the **model
version and the inputs**, not just the outputs. The table already stores `inputs JSONB` "so the full
result can be recomputed anywhere" — the right instinct, defeated by having one row.

---

## 5. Why this reverses the "Kira is the wrong consumer" call

The eng review concluded Kira was the wrong consumer. That was wrong, and the valuation model is why.

**Owner dependence (weight 3) and systems (weight 2) are half the score, and neither is measurable
from accounting data.** They move only through conversation — which is precisely what Kira is.
Client concentration and recurring revenue *are* derivable from invoice patterns, which is what the
accounting adapter gives you.

```
Kira conversation ──► owner dependence, systems       ─┐
                                                        ├─► readiness ──► valuation ──► the number climbs
Adapter/radar data ──► concentration, recurring revenue ─┘
```

**The radar is not a separate product that shares a customer. It is the other half of the instrument
that moves the score.** That also dissolves the radar plan's month-3 cliff: the client is not
watching a punch list shrink, they are watching a number climb toward a defined maximum.

---

## 6. Re-scoring — decided 2026-07-27

**Locked:**
1. **The system re-scores automatically, weekly**, with a time-based chart showing progress from
   baseline → current → maximum. Weekly rebasing to check progress.
2. **Actions are rows in `kira_tasks`.** `kira_tasks.kind` is currently
   `'quote' | 'email' | 'reminder' | 'unsupported'`, so improvement tasks need a new kind. Note an
   improvement task is not something Kira *does* — it is something the **owner** does while Kira
   preps it and captures the outcome. That is the `assisted` tier from the eng review finding its
   first real use.

**What evidence earns a re-score:**

| Factor | Weight | Moves on | Source |
|---|---|---|---|
| Owner dependence | 3 | Delegation breadth + tasks running without the owner | **System-observable** |
| Systems | 2 | Business knowledge durably captured | **System-observable** |
| Recurring revenue | 2 | Invoice cadence and repeat patterns | Accounting adapter |
| Client concentration | 1.5 | Invoice distribution across clients | Accounting adapter |
| Growth | 1.5 | Not capturable | — |

**Five of the ten weight points are observable from the system's own behaviour, with no adapter
required — so the score can start climbing before a single adapter exists.**

- **The delegation policy is an owner-dependence instrument.** An owner who moves from *"show me
  everything"* to *"anything under $500, just do it"* has literally reduced their own dependence,
  and the system holds that policy, versioned, with the trust ratchet's evidence behind every
  widening. Not a proxy — the thing itself, measured directly.
- **Knowledge capture is the systems instrument.** `kira_knowledge` and `kira_knowledge_chunks`
  already exist; *"is it documented and transferable, or in your head?"* is answerable from how much
  of the business is durably recorded and retrievable.
- **Task reduction** splits into two signals that mean different things: **delegated** (now runs
  without the owner — band moved to `auto`/`notify`, and the system can prove this) and
  **eliminated** (stopped being needed at all).
- **The weekly satisfaction survey is recommended OUT of scoring.** It maps to no readiness factor;
  the nearest chain (satisfaction → retention → recurring revenue) is indirect enough to be noise,
  and it asks the owner to survey their clients weekly, risking their relationships to feed our
  number. Possibly a good feature on its own merits; a poor scoring input.

**Two problems this creates:**

1. **The system marks its own homework** — it observes delegation, raises the score, raises the
   valuation. The worst version is already defused (`quoted_monthly` is locked at signup, so a
   climbing score does not change what they pay), but the softer version stands: the product
   measures its own effectiveness and reports the result to both the owner and their introducer.
2. **Weekly re-scoring produces a flat line most weeks**, plus jitter on the accounting factors when
   invoice mix shifts. A wobbling score looks unreliable; a flat line with no explanation looks
   broken. Recommendation: re-score weekly but **only move a factor when there is evidence**, so the
   chart is a stable line that *steps*, with the reason attached — *"+0.04, you delegated supplier
   chasing."* Same design decision that made the radar's quiet weeks readable.

---

## 7. Factor movement — RESOLVED 2026-07-27

**The owner confirms — but within an objective framework, not a subjective one.**

A factor never moves on inference alone. But the confirmation must not be an opinion poll. The
owner is never asked *"do you feel less essential?"* — they are shown **evidence** and asked to
confirm a **fact**:

> *"Over the last six weeks, 23 supplier chases ran without you touching one. Confirm that's now
> normal operation, not a quiet patch."*

The distinction is load-bearing three ways:
- The owner **cannot flatter the number**, because they are confirming a count, not a feeling.
- The owner **cannot deflate it** either, which matters — owners systematically under-rate their own
  progress, and a subjective prompt would suppress real movement.
- The **evidence is the audit trail.** When a buyer asks how the number was derived, the answer is a
  dated record of observed behaviour that the owner countersigned — not an AI's assessment.

So each factor level needs an **objective admission test** defined up front: the observable
condition that must hold before the system is even allowed to *ask* for confirmation. Owner
dependence `heavily_involved → mostly_runs` is not "the owner thinks it mostly runs" — it is a
stated, measurable threshold on delegation breadth and untouched-task volume, sustained over a
stated window.

**Drafted 2026-07-27 → `ADMISSION_TESTS.md`.** An admission test per level of every factor: a
measured quantity, a threshold, a sustaining window, a named data source. Thresholds are v0 and
uncalibrated; the shape is settled. Two findings from drafting it worth carrying here:

- **Only the two system-observable factors need owner confirmation.** Recurring revenue,
  concentration and growth are arithmetic over the client's own invoices — asking an owner to
  confirm their largest client is under 35% of revenue would be theatre. So the factors the system
  could be accused of marking its own homework on are exactly the ones behind a countersignature.
- **A single-principal tenant cannot reach `documented_team`**, because the test is non-owner use of
  captured knowledge and there is no non-owner. Correct rather than awkward — a one-person business
  genuinely is less transferable — but it makes `principal_id` valuation-bearing, not just an
  authorisation column.

---

## 8. The 0–100 scale — right for display, but nuance has to come from somewhere else

The 0–100 ask is correct and trivially compatible: `readiness` is already a 0–1 score, so the
display is `readiness × 100`. **But the scale is not where the nuance lives, and changing it alone
buys nothing.** The factors are coarse enums (verified in `lib/valuation/model.ts:92–103`):

| Factor | Weight | Levels | Points on a 0–100 scale |
|---|---|---|---|
| Owner dependence | 3 | 0 / 0.33 / 0.7 / 1 | 0 → 9.9 → 21 → 30 |
| Systems | 2 | 0 / 0.5 / 1 | 0 → 10 → 20 |
| Recurring revenue | 2 | 0 / 0.5 / 1 | 0 → 10 → 20 |
| Client concentration | 1.5 | 0 / 0.5 / 1 | 0 → 7.5 → 15 |
| Growth | 1.5 | not capturable | — |

Three consequences, and they hit the dashboard directly:

1. **There are only 36 reachable capturable states** (4 × 3 × 3), and the **smallest possible move
   is 7.5 points; the largest single step is 11.1.** A weekly chart across 6–12 months would contain
   perhaps three to six events, each a double-digit jump. That is not a climbing line — it is a
   staircase with very few stairs, and most weeks are dead flat.
2. **The ceiling is per-client, not fixed.** `model.ts:206` gives non-capturable factors their actual
   score in `readinessPotential`, so growth (weight 1.5) contributes the client's own trend: the
   maximum is **85 + up to 15**, already personalised at baseline. Growth is excluded from the
   improvable set by design — we do not claim to grow their profit — so the ceiling is not something
   the work moves, and it can drift **down** if their trends deteriorate.
3. Widening the display scale does not fix either. **A 0–100 readout over a 4-level enum is still a
   4-step staircase.**

### Two tracks, only one of which touches the money — AGREED 2026-07-27

| | **Readiness (valuation-bearing)** | **Progress (0–100 display)** |
|---|---|---|
| Moves on | Owner-confirmed factor level changes only | Objective evidence, continuously |
| Granularity | Coarse — 7.5–11 point steps | Fine — moves weekly |
| Drives | The dollar valuation, the introducer board | The chart, the sense of momentum |
| Defensible to a buyer | Yes — countersigned evidence | Not claimed to be |

Progress accumulates *within* a band and shows how close the next confirmation is — *"you're 70% of
the way to the evidence threshold for `mostly_runs`"*. Readiness steps when the owner confirms.
The chart shows a live line that means something every week, while the number a buyer would rely on
only moves when a human countersigned it. This satisfies the nuance ask **without letting the system
mark its own homework on the valuation**, which is the failure mode §6 flagged.

---

## 9. Completion — the pricing has a built-in self-destruct

This is the sharpest thing in the restated flow, and the instinct behind *"maybe rebase the pricing
at that point?"* is correct.

**The price is defined as a fraction of the gap** (`fractionOfGap`, `fractionWorthQuoting`). The
product's goal is gap → 0. **So success destroys the price's own justification.** You cannot keep
charging $1,999/month as "a small fraction of your gap" once the gap is closed — the first owner to
do that arithmetic will say so, and they will be right.

Three honest options, not mutually exclusive:

- **(a) Rebase to an "operate" tier at completion.** The price stops being gap-derived and becomes
  value-of-the-assistant derived — what the EA is worth per month to run the business, independent
  of sellability. This needs a deliberate re-quote path: **`quoted_monthly` is locked at signup by
  design**, so a rebase is a schema-and-consent event, not a config change.
- **(b) Accept that a share of completions churn — and that this is a win.** They sell. We lose the
  subscription and gain the single best case study available: a business that sold at a higher
  multiple, with the broker's own numbers as proof. Also worth noting the **new owner inherits a
  systemised business and the assistant that runs it** — the warmest possible customer.
- **(c) Let the gap reopen** — readiness decays if delegation reverses. **Not recommended.** It
  makes the product's revenue depend on the customer backsliding, which is the wrong incentive to
  build into the pricing model.

**AGREED 2026-07-27: (a) + (b).** Completion is named as a real event, a rebased operate tier follows
it, and exit-churn is treated as a marketing asset rather than a leak. **The rebased figure itself is
deliberately deferred** — it is set as we go, once there is a completed client to set it against.
(c) stays rejected.

### 9.1 The broker conflict, stated plainly

*"When the score hits max, the advisor can re-check with the owner on sale"* creates a second payoff
for the advisor: a listing on a business that has been deliberately made sellable. That belongs in
the advisor demo — it is a stronger pitch than the referral fee alone.

**But the commission is not noise, and an earlier draft of this doc was wrong to call it that.**
Ten clients on the $1,500 band pay $150 each — **$1,500/month recurring** to the advisor, before any
exit. Both payoffs are real; the exit is larger and one-off, the commission is smaller and
compounding. The correction matters for the copy: *"it won't move your revenue"* is plainly false at
that book size, so §3's replacement wording is required, not optional.

Two things it forces:

- **Consent.** The client must know at signup that their advisor is told when they reach sale-ready.
  That is a status projection, so it sits inside the existing `canViewContent()` boundary — but it
  is new information about them going to a third party, and it belongs in the consent copy.
- **A conflict worth naming rather than hiding.** The broker earns at exit; we earn recurring. The
  broker is therefore incentivised to end our subscription. That is not fatal — it is the promise we
  made, and (b) above absorbs it — but it should be a deliberate acceptance, not a surprise.

---

## 10. Also open

- **"The introducer is always the sender, we never are"** — locked in the Kira build state, and it
  kills the radar plan's model of us emailing the client a briefing. The v1 shape is
  compose-and-hand-off: the portal drafts, the introducer sends from their own client. The radar
  plan's three surfaces need reconciling against this.
- **The objective admission test per factor level** (§7) — the next real specification job.
- **Which readiness factors the accounting data can actually move, and how confidently.**
  Concentration is computable; recurring revenue is inferable; the rest is not.
- **Whether growth becomes capturable** once financial data is connected — it decides whether the
  dashboard maximum is 85 or 100.
