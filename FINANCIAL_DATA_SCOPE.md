# Financial data — what we need, whether Xero has it, and the shape that follows

**Version** 0.1 — expectation-setting for D8
**Owner** Dennis McMahon, Corporate AI Solutions
**Companions** `VALUATION_LOOP.md` (the loop) · `ADMISSION_TESTS.md` (what moves a factor)

> **The framing correction that comes first.** An earlier note said the accounting adapter governs
> 41% of the improvable gap and therefore `gap → 0` is unreachable without it. That arithmetic is
> right and the emphasis was wrong. **The majority of sellability is operational, not financial** —
> whether the business is owner-run or system-run. That half is 59% of the improvable gap, it needs
> no adapter, and it is the half nobody else can see. Xero is a **completion dependency, not a
> launch dependency.**

---

## 1. The split, stated plainly

| Half | Factors | Weight (of 8.5 improvable) | Source | Who else can see it |
|---|---|---|---|---|
| **Operational** — is it owner-managed or system-managed? | Owner dependence (3), Systems (2) | **59%** | Our own system behaviour | **Nobody.** This is the moat. |
| **Financial** — what do the books say? | Recurring revenue (2), Concentration (1.5) | **41%** | Accounting adapter | Any competitor with a Xero connection |

Growth (1.5) sits outside both — measured, never improved (`ADMISSION_TESTS.md` §7).

**Sequencing consequence:** build the operational instrumentation first. It is the larger half, it is
the differentiated half, and it starts working on day one with no third-party dependency. The
adapter is necessary to *finish* the promise, not to *start* delivering it.

---

## 2. (a) What would actually be useful from the finances

Two distinct classes, and conflating them is how this gets over-scoped.

### Class 1 — valuation factors (monthly, slow, authoritative)

| Need | Why | Feeds |
|---|---|---|
| **Revenue by customer, trailing 12 months** | Largest-client and top-3 share | Client concentration |
| **Invoice cadence per customer** | Repeat/regular patterns = recurring revenue | Recurring revenue |
| **Explicit repeating/contracted invoices** | The unambiguous form of the same signal | Recurring revenue |
| **Profit trend, TTM vs prior TTM** | Direction of earnings | Growth |
| **Gross margin trend** | Quality of earnings | Growth |
| **Active customer count trend** | Base expanding or shrinking | Growth |

### Class 2 — radar / watch items (daily, fast, operational)

| Need | Why |
|---|---|
| **Debtor ageing (30/60/90)** | *"Debtors past 60 days come off your valuation, not just your cashflow."* |
| **Quotes issued and unanswered** | Chase-window prompts |
| **Invoices raised vs work completed** | The "unbilled work" flow |
| **Customers gone quiet** | Last-invoice recency per customer |

**These do not feed the score directly.** They generate the tasks whose *completion without the
owner* moves owner dependence. That is the actual coupling between the radar and the valuation, and
it is indirect by design.

---

## 3. (b) Does Xero hold it?

⚠️ **Confidence: MEDIUM on API specifics.** The endpoint families below are ones I'm reasonably
confident exist in the Xero Accounting API, but names, shapes and limits change and my knowledge has
a cutoff. **Verify against current Xero developer docs before building against any of it.** This
table is for scoping, not implementation.

| Need | In Xero? | Via |
|---|---|---|
| Revenue by customer TTM | ✅ Yes | Invoices grouped by Contact; also the Aged Receivables by Contact report |
| Invoice cadence per customer | ✅ Yes | Invoice history per Contact — derived, not a field |
| Repeating/contracted invoices | ✅ Yes | Repeating Invoices endpoint — explicit, no inference needed |
| Profit trend | ✅ Yes | Profit & Loss report with comparative periods |
| Gross margin trend | 🟡 **Quality-dependent** | P&L, but only if COGS is classified consistently — frequently it isn't in small businesses |
| Active customer count trend | ✅ Yes | Derived from invoices per period |
| Debtor ageing | ✅ Yes | Aged Receivables report |
| Quotes outstanding | ✅ Yes | Quotes endpoint |
| **Work done, unbilled** | ❌ **Largely NO** | Xero has no native WIP/job costing. Needs Xero Projects (separate module + API) or the job-management system — Simpro, ServiceM8, WorkflowMax. |
| **SDE / adjusted profit** | ❌ **No** | Requires add-backs (owner salary, perks, one-offs) that no ledger identifies automatically. Stays a judgement input. |

### Three expectations this sets

**1. "Work done, unbilled" is not a Xero flow.** The radar plan lists it as Xero-visible. It isn't,
for most businesses — it lives in the job system, not the ledger. Either scope it to businesses
running Xero Projects, or accept it needs the second adapter, or drop it from the v1 promise.

**2. Margin trend will be unreliable for a meaningful share of clients.** Gross margin needs a
consistently classified P&L. Where the classification is poor, **degrade honestly** — report the
factor as unavailable rather than computing a confident number from bad inputs (`DATA_STANDARD` R4).

**3. SDE stays self-reported, and it is the biggest single number in the model.** The whole valuation
is `SDE × multiple`. Xero can give you net profit; it cannot identify add-backs. So connecting the
adapter improves the *readiness* side and leaves the *earnings* side exactly where it is — which is
worth knowing before anyone assumes a connection makes the valuation "verified."

---

## 4. The shape this sets from the start

**Store derived metrics, not raw ledgers.** We need six numbers per month, not a copy of their
accounts. Pull, derive, persist the metric plus its inputs and period, discard the rest. Smaller
blast radius, smaller privacy surface, and it survives the client disconnecting.

**These are STRUCTURED facts** (`DATA_STANDARD` D1) — exact, auditable, valuation-bearing. Canonical
tables, never RAG, never Mnemo.

**Snapshot with the model version** (`VALUATION_LOOP.md` D5). Same rule as readiness: a metric
recorded without the code that produced it can't be recomputed or defended later.

**Two cadences, deliberately.** Class 1 monthly (TTM-smoothed, valuation-bearing, must not wobble).
Class 2 daily (operational, feeds the radar, allowed to be noisy).

**Degrade, don't fake.** No connection → the three accounting factors stay at their **self-reported**
baseline and are **labelled as self-reported**, on every surface including the introducer board. An
unverified number presented as verified is the failure this rule exists to stop.

### 4.1 The event nobody has designed yet: connection can lower the score

At signup, all five factors are self-reported through the 3-minute questionnaire. When the adapter
connects, three of them get **corrected** — and owners systematically over-rate their own
diversification and recurring revenue.

**So connecting Xero will sometimes drop the number.** That is the system working correctly, and it
will feel like the opposite. Two consequences:

- **Ask for the connection early**, framed as *"verify your baseline"*, not late as *"unlock more
  score."* A correction at week one is a credibility win; the same correction at month four looks
  like the product moved the goalposts.
- **A corrected baseline must be visibly distinct from a regression.** The chart cannot show
  "verified your figures" the same way it shows "you took back control of supplier chasing" — same
  direction, opposite meaning.

---

## 5. What's still owed

- **Verify the Xero API specifics** in §3 against current developer docs. *(Endpoint families still
  unverified — the connection-limit question below is closed, this one is not.)*
- ✅ **Xero app certification — CLOSED 2026-07-27. Not a launch blocker.**

### 5.1 Xero certification — the answer to T-A1

**An uncertified app can hold 25 permanent active connections** (demo companies excluded), with a
limit of ~2–3 uncertified apps per organisation. A certified **App Partner** has no meaningful
limit. Certification runs **9 checkpoints**, requires **3 active customer connections inside 30
days**, and Xero's own material says it **can take several months**. Organisations can also purchase
a **Custom Connection** per app, which does not count against the uncertified cap.

**So T-A1 was over-weighted, and this closes it as a calendar dependency.** 25 connections is far
beyond anything validation needs — it is a **scale gate that bites at roughly the 25th paying
client**, not a launch gate. Two useful consequences:

- **Nothing in the validation phase is calendar-blocked by Xero.** The earlier framing ("every
  tranche past week one is calendar-blocked") was wrong.
- **Certification can start early and cheaply**, because its own entry requirement is only 3 active
  customer connections. Begin it once the first few clients connect, and the months it takes run in
  parallel with getting to 25 — rather than starting at 25 and stalling there.
- **Decide the "unbilled work" position** — Projects-only, second adapter, or out of the v1 promise.
- **Confirm nothing in the ops half is quietly waiting on the adapter.** The claim that 59% needs no
  third party is load-bearing for the sequencing above and should be checked, not assumed.
