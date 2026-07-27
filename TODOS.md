# TODOS

Only items **not already covered** by the four spec documents. The deferred architecture (envelope,
registry, handlers, classifier, entity index, pattern store, plugin contract, elicitation, on-prem)
is written up in far more detail in those documents than a TODO line could carry — read them, don't
re-list them here.

Created 2026-07-27 from `/plan-eng-review`.

---

> ⚠️ **Reconciled 2026-07-27 after the channel pivot.** Current plan: CEO plan rev 3
> (`~/.gstack/projects/orchestrator/ceo-plans/2026-07-27-radar.md`). Referral channel, direct-to-
> client billing, no voice, no inbox reading. Items marked **MOOT** below are retained rather than
> deleted so a future session sees they were considered and why they lapsed.

## DECISION REGISTER — opened 2026-07-27 by the valuation-loop work

Decisions only. Work items live below. Full context: `VALUATION_LOOP.md` · `ADMISSION_TESTS.md`.

### Blocks the first advisor demo
| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | **Referral-fee disclosure position** (was T-B2) | Verify the standard first · run the demo on the firm-level opt-out as the compliance answer | **Verify first** — an hour of reading, and this audience asks in the first meeting |
| D2 | **Commission copy** now that 10% is confirmed | Keep *"it won't move your revenue"* · replace with the honest version | **Replace.** At $150 × 10 clients it is false, and this audience does the arithmetic live |
| D3 | **What the advisor board displays** | Readiness (coarse, countersigned) · progress (weekly, objective) · both | **Both, labelled** — readiness is the claim, progress is the movement |
| D4 | **Client consent that the advisor is told at sale-ready** | In signup consent copy · ask at the time · don't tell the advisor | **Signup consent** — it is new information about them going to a third party |

### Blocks the first paying client
| # | Decision | Options | Recommendation |
|---|---|---|---|
| D5 | **Valuation snapshot contract** (fixes the §4.1 live defect) | Cadence, and whether snapshots store model version + inputs | **Weekly, storing model version + inputs** — else a model change retroactively rewrites everyone's climb |
| D6 | **Does readiness fall?** | Falls with evidence · ratchet, never falls · falls but the advisor sees only the current level | **Falls** — a score that can only rise is not a measurement. Interacts with pricing §9 |
| D7 | **Who names the core operating areas** (systems denominator) | Owner at onboarding · we propose per industry, owner edits · derived from observed task kinds | **Propose + owner edits** — an empty denominator makes §3 unscoreable |

### Blocks the score climbing
| # | Decision | Options | Recommendation |
|---|---|---|---|
| D8 | **Xero certification** (was T-A1, now elevated) | Verify threshold + timeline before sequencing | **Verify now.** It gates 3 of 5 factors *and* the 85→100 ceiling — the largest unnamed dependency |
| D9 | **Owner-activity detection** for the absence test | Build cross-surface activity tracking · drop the absence test · self-declared holiday window | **Build it** — without it `fully_managed` is unreachable, and a holiday looks like a quiet week |
| D10 | **Scope of "the introducer is always the sender, we never are"** | Referral stage only · all client email forever | Likely **referral stage only** — but it is locked in Kira's build state and the radar plan's briefing surface depends on the answer |

### Resolutions — 2026-07-27
| # | Resolution |
|---|---|
| D1 | **RESEARCHED 2026-07-27 → `REFERRAL_FEE_POSITION.md`.** Permitted, regulated by **disclosure not prohibition**. APES 110 §330: written disclosure of the fee, its payer and how calculated. TPB conflicts-of-interest: disclose **the amount**, **before or when the service is provided**, positive written consent recommended. **One hard prohibition — an accountant providing ASSURANCE services to that client cannot take the fee at all.** Conflicted-remuneration rules almost certainly not engaged (we are not a financial product). **VERIFIED 2026-07-27:** APES 110 §330 is **unchanged** by the 2022 fee amendments (those landed in s410/Part 4A auditor independence — the 20% fee-dependency threshold); the **2024 TPB Determination's 8 new obligations do NOT bear on referral fees** (its conflicts item is scoped to government work; "keeping clients informed" is about misconduct disclosure). **Still owed:** lawyer review, and one confirming read of TPB(I) 19/2014 — tpb.gov.au was unreachable across ~6 attempts, so the TPB position is corroborated but not directly read. |
| D2 | **Replace the copy.** Honest version adopted; *"it won't move your revenue"* retired. |
| D3 | **Both**, labelled — readiness is the claim, progress is the movement. |
| D4 | **Signup consent** covers telling the advisor at sale-ready. |
| D5 | **Weekly snapshots storing model version + inputs.** |
| D6 | **Symmetric measures, asymmetric gating** — the same metrics move the score both ways; increases need owner confirmation, decreases apply on evidence. Needs a hysteresis band (§ below) so the score steps rather than flaps. |
| D7 | **Propose per-industry, owner edits.** Denominator versioned; changing it is recorded as a denominator change, never as progress or regress. |
| D8 | **SCOPED 2026-07-27 → `FINANCIAL_DATA_SCOPE.md`.** Emphasis corrected: sellability is **59% operational** (owner-managed vs system-managed — no adapter, and the half nobody else can see) and **41% financial**. Xero is a **completion dependency, not a launch dependency.** Xero holds revenue-by-customer, cadence, repeating invoices, P&L trends, aged receivables and quotes; it does **NOT** hold **unbilled work/WIP** (needs Xero Projects or the job system — the radar plan wrongly lists it as Xero-visible) or **SDE add-backs** (stays self-reported, and it is the largest number in the valuation). Margin trend is quality-dependent. **Still owed:** verify API specifics, T-A1 certification timeline, the unbilled-work position. |
| D9 | **Build owner-activity detection.** |
| D10 | **DELETED — struck at source 2026-07-27.** *"The introducer is always the sender, we never are"* is obsolete; advisors refer clients to us and we run the valuation, demo and onboarding. Corrected in Kira `docs/BROKER_CHANNEL_BUILD_STATE.md` in three places: the locked-decision line (struck, retained with reason), **C5** (re-decide before building — the compose-and-hand-off shape existed *because* of the rule), and **C v2 OAuth send** (gate may be void; possibly cancelled, not deferred). |

### Named and deliberately deferred
- **The rebased operate-tier figure** — set against a real completed client (agreed 2026-07-27).
- **Admission-test thresholds** — v0, calibrated on the first cohort.
- **The broker conflict** — broker earns at exit, we earn recurring. Accept deliberately, don't discover.

---

## BLOCKING — the current channel

### T-B2 · Verify the referral-fee disclosure position (was CEO-plan B2)
**What:** Confirm what Australian accountants' professional standards actually require when they
receive a referral fee — which standard, what disclosure form, whether it differs for a licensed
adviser versus a public accountant.
**Why:** The advisor copy says *"we'll only pay it where you can disclose it and it doesn't cut
across your obligations."* That sentence is much weaker if we cannot say what disclosable means, and
this audience will ask in the first demo.
**Context:** Flagged three times across the CEO review and never resolved. Declare the position per
the `REGULATORY_INCLUSIONS` pattern rather than assuming it.
**Priority:** P1 · **Blocks:** the first accountant demo.

### T-B3 · Decide commission structure — one-off or trailing
**What:** A single payment on conversion, or a percentage while the client stays.
**Why:** Trailing aligns the advisor to retention, which is the whole question under a model where
the acquisition promise completes at 6–12 months. One-off is simpler and they stop caring the day
after signup.
**Recommendation:** trailing. **Priority:** P1 · **Blocks:** the advisor agreement.

---

## BLOCKING — verify before planning anything past week one

### T-A1 · ~~Verify Xero app certification requirements~~ — **CLOSED 2026-07-27**
**Answer:** an uncertified app holds **25 permanent active connections** (demo orgs excluded);
certified App Partners are effectively unlimited. Certification = 9 checkpoints, needs **3 active
customer connections within 30 days** to enter, and can take **several months**. Custom Connections
are purchasable per-org and don't count against the cap.

**Verdict: not a launch blocker — a scale gate at ~25 paying clients.** The original fear ("every
tranche past week one is calendar-blocked") was wrong. Better still, certification's entry
requirement is only 3 connections, so it can be started with the first few clients and run its
months in parallel with growth instead of stalling at 25. Detail: `FINANCIAL_DATA_SCOPE.md` §5.1.

### T-A2 · ~~Verify Google CASA requirements for `gmail.readonly`~~ — **MOOT**
**Lapsed 2026-07-27.** Inbound-email discovery was part of the systems-sweep onboarding. The referral
channel replaces it entirely: the accountant exports the client's debtor report, so nothing reads a
mailbox. Revive only if the systems sweep (`EXECUTION_LAYER` §16) comes back.

<details><summary>Original</summary>
**What:** Confirm whether inbound-email discovery (§16.1's second-best signal) needs a third-party
CASA security assessment, its cost, and whether it recurs annually.
**Why:** Same as above — sits in front of the discovery sweep, cannot be compressed.
**Pros/Cons/Context:** As T-A1.
**Blocked by:** — · **Blocks:** §16 systems discovery via inbound senders.
</details>

---

## SECURITY — before any multi-user tenant

### T-S1 · ~~Speaker identity ≠ principal~~ — **MOOT**
**Lapsed 2026-07-27.** There is no voice channel in the current build. This was the sharpest security
finding of the eng review and it lapses only because the surface it attacked no longer exists — it
returns the moment voice does. Do not delete.

<details><summary>Original</summary>
**What:** The `SAY` ingress derives `principal_id` from ElevenLabs' server-baked `?uid`, which
identifies the **agent owner**, not whoever is speaking. In a shared-office setting anyone in earshot
can issue instructions under the owner's authority.
**Why:** The entire delegation chain (portfolio → tenant → role ceiling → principal grant) rests on an
identity the primary channel cannot establish. This is precisely the authority-laundering failure
`ORCHESTRATOR_SPEC` §7.4 was written to close, re-entering through the front door.
**Pros:** Closing it makes the delegation model honest.
**Cons:** Voice speaker verification is genuinely hard; the realistic mitigations are a spoken PIN for
band-raising actions, or capping the voice channel to the owner's own grant and requiring the web
surface for anyone else.
**Context:** Safe at n=1 because the owner is the only speaker — **write that assumption down rather
than leaving it unexamined**, because it silently becomes false at tenant #2.
**Blocked by:** — · **Blocks:** any tenant with more than one principal.
</details>

### T-S2 · Global kill switch
**What:** A single row the outbox drain checks before every dispatch. Plus an incident mode that
halts sweeps without a redeploy.
**Why:** Nothing in four documents can stop the system mid-flight. The unrecoverable failure is a
*wrong send at volume* — one bad template × fifty recipients at 2am, under the client's ABN.
**Pros:** Hours to build. Converts an unbounded blast radius into a bounded one.
**Cons:** None worth naming.
**Context:** X2 chose draft-only for week one, which mitigates but does not replace this — draft-only
is a posture, a kill switch is a control.
**Blocked by:** — · **Blocks:** the first unattended send.

### T-S3 · Enforce `approved` at the database, not by convention
**What:** `ORCHESTRATOR_SPEC` §8 says only a human actor may enter `approved`. Handlers run with
service credentials against the same Postgres, so nothing enforces it.
**Why:** The design's pitch is that gates are *structurally* true. This is the one place they're
behavioural.
**Context:** A trigger refusing the transition without a matching `approvals` row closes it.

---

## CORRECTNESS — design conflicts found, not yet resolved

### T-C1 · E4 (derived reversibility) conflicts with §7.2 (band resolved at dispatch)
**What:** Bands resolve before the handler runs. For **agentic** flows the effects — and therefore
reversibility — are only known after the loop completes. So the highest-risk tier resolves its band
from a manifest-declared assertion, which is exactly what E4 says not to do.
**Why:** The two decisions are incompatible for the tier where it matters most.
**Options:** re-resolve the band after the agentic loop and before any effect dispatches (probably
right); or accept declared reversibility for agentic only, and say so.
**Blocked by:** — · **Blocks:** the agentic tier.

### T-C2 · Trust ratchet counter-signal
**What:** §7.2 widens authority after N approvals **with no edits**. §13 names rubber-stamping as a
top risk. Unchanged-approval measures *attention*, not correctness — and the ratchet fires exactly
when attention has decayed.
**Why:** Same document, same signal, opposite conclusions.
**Options:** spot-check sampling; widen only after an edit-then-stabilise pattern; require a fresh
confirmation at widen time that re-reads a real example. Or don't ship the ratchet.
**Context:** X2's draft-only week generates this evidence safely — that's the phase to design it in.

### T-C3 · Ambiguous-send reconciliation is specified as a principle, not a mechanism
**What:** `EXECUTION_LAYER` §5.1 says never blind-retry an ambiguous send and reconcile against the
provider first. No document says how, per provider.
**Why:** Silent failure class. Duplicate sends to a client are unrecoverable.
**Context:** Resend, Stripe and Xero each expose idempotency keys or external refs — the mechanism
exists per provider, it just isn't written down.

### T-C4 · Path A / Path B dedupe does not work "for free"
**What:** §4.2 claims post-call extraction reconstructs the same idempotency key as the in-call
dispatch. It cannot — the transcript's rendering of the utterance and its timestamp both differ.
§5.3's semantic fallback then risks dropping legitimate repeats ("chase Dave again").
**Why:** The claim is stated as settled and isn't.
**Also:** the `SAY` key includes `captured_at_minute`, so a retry across a minute boundary duplicates.

---

## OPERATIONS

### T-O1 · Unit economics
**What:** Every `SAY` dispatch is ≥1 model call; ambient extraction runs over every transcript;
agentic loops are uncapped in price terms. `BUSINESS_MODEL` §3 clips $10–20 per active end-user per
month, but orchestrator cost scales with **flow volume**, not headcount.
**Why:** Those are different axes and nothing reconciles them. This determines whether the agentic
tier is affordable at all — the tier §11 spends most of the engineering on.
**Context:** R12/R14 are cited for caps; who sets the cap and against what price is unwritten.

### T-O2 · Tenant consent basis for the tenant's own contact list
**What:** `assertCompliant()` checks the footer and unsubscribe. It cannot know whether the tenant's
"reawaken quiet client after 6 months" list has a lawful basis under the Spam Act.
**Why:** One tenant with a scraped list makes that our incident, on our infrastructure.
**Context:** Needs a consent-basis attestation at onboarding, recorded per list.

### T-O3 · Sustained source-system unavailability
**What:** Confirm-before-act couples every send to a third-party call. Xero down for six hours means
the nightly sweep dead-letters wholesale and the owner wakes to 200 failed tasks.
**Why:** That's approval fatigue re-entering through a door the delegation model doesn't cover.
**Context:** "Fails to the queue with the reason" is correct per item and wrong in aggregate.
