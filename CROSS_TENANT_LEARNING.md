# Cross-Tenant Learning — the pattern layer

**Version** 0.1 — scoping draft
**Owner** Dennis McMahon, Corporate AI Solutions
**Companions** `ORCHESTRATOR_SPEC.md` · `EXECUTION_LAYER.md` · `TASK_REGISTRY.md`

> **Why this exists now, before there is any data.** Every client teaches the system something about
> how businesses work, and that knowledge should make the next client cheaper to onboard and the
> existing ones better served. But cross-tenant learning is also the single most dangerous capability
> in a multi-tenant system holding businesses' financial records and client correspondence. The
> boundary has to be **architecture, not policy** — decided before the first tenant, because
> retrofitting it after data has pooled is not a refactor, it is a breach notification.

---

## 1. The two directions

The user requirement has two halves and they need different machinery:

| Direction | Question | Output |
|---|---|---|
| **Upward** — learning | What patterns hold across businesses? | Adapter roadmap · registry growth · onboarding defaults · template selection |
| **Downward** — benefit | What should *this* business do differently? | A benchmark and recommendation surface the owner actually sees |

The downward half is the one that makes the upward half acceptable. A system that harvests patterns
and gives nothing back is extraction; one that returns *"most businesses your size chase at day 30
and day 37 — you chase once at day 45"* is a reciprocal trade the owner would opt into.

---

## 2. The boundary — three tiers, and only two cross

This is the load-bearing rule. Everything else is detail.

| Tier | Contents | Crosses? |
|---|---|---|
| **T1 — Structural metadata** | Which tools exist, integration type, adapter availability, which flows are covered/absent, tier and ingress distributions | **Yes**, freely. This is metadata about *the system*, not about the business's customers. |
| **T2 — Aggregate statistics** | Delegation-band norms, template performance, coverage rates, follow-up cadence effectiveness, failure rates | **Yes, under k-anonymity** (§5). Counts and distributions only. No free text, ever. |
| **T3 — Content** | Utterances, transcripts, client names, prices, invoices, drafts, Ground Rules prose, entity records, effect payloads | **Never. Full stop.** |

> **The rule in one line: what crosses is counts and shapes, never contents.**

Nothing that could identify a tenant, their client, or their commercial position leaves the tenant's
scope. A stat that survives is *"the median auto-approve spend limit for trades businesses of 100–300
staff is $250"*; a stat that does not is anything a competitor could act on.

### 2.1 The classifier exception that is not an exception

The tempting one: pool utterances across tenants to improve routing. **No.** If cross-tenant
classifier improvement is wanted, the unit that crosses is the **abstracted intent shape** — a
distilled, de-entitied pattern — never the sentence. `DATA_STANDARD` I4 (Mnemo ingests distilled
results, never raw artifacts) applied one level up.

The same applies to the `unroutable_requests` pooling already promised in `ORCHESTRATOR_SPEC.md` §5.4:
it crosses as *"an unmatched request of shape X occurred N times across M tenants"*, not as the
owner's words.

---

## 3. What we actually learn

Seven pattern classes, ordered by how quickly they pay off.

| # | Pattern | Feeds | Tier |
|---|---|---|---|
| 1 | **Tool co-occurrence** — *"73% of trades businesses this size run Xero + Simpro; Simpro almost always implies Deputy"* | Adapter roadmap, and what to expect before a sweep runs | T1 |
| 2 | **Coverage gaps by vertical** — *"certificate expiry tracking is absent in 91% of trades businesses"* | Product roadmap, and the sales pitch. Also the honest answer to "is our wedge real?" | T1 |
| 3 | **Delegation norms** — the distribution of spend bands, `reserved` lists, what owners actually delegate | **Onboarding defaults + the benchmark surface.** The highest-value one — see §4. | T2 |
| 4 | **Template and cadence performance** — which chase wording gets paid soonest, which follow-up rhythm converts | Template selection and recommendation | T2 |
| 5 | **Unroutable shapes** — what people ask for that no manifest covers | Registry growth (§6) | T2 (abstracted) |
| 6 | **Failure patterns** — which connectors break, which effect classes fail, recurring error shapes | Reliability work, and pre-emptive warnings to other tenants | T1 |
| 7 | **Archetype refinement** — do the 140 flows hold? Do recognisable sub-archetypes emerge? | `TASK_REGISTRY.md` itself | T1 |

### 3.1 The registry becomes living

Pattern 5 is the important structural one. A flow that appears in one tenant and is not in the 140
gets **proposed** as a registry addition; a flow that appears in a *second* unrelated tenant is the
promotion trigger into the core library.

That is `BUSINESS_MODEL.md` §6's shared-service extraction detector — second occurrence is the
trigger — pointed at business flows instead of code. The registry stops being a document Dennis wrote
and becomes a document the portfolio maintains.

---

## 4. The downward half — the benchmark surface

This is a product feature, not internal tooling, and it is the strongest argument for the whole
layer.

**At onboarding**, the sweep and the hour both get sharper. Kira arrives already knowing what a
business of this shape probably runs and what is probably missing:

> *"Businesses your size usually let their assistant go to about $250 without checking. Want to start
> there and adjust?"*

That turns the hardest question in the elicitation session — *"what should my limits be?"*, which
almost nobody can answer cold — into a nudge with a sensible default behind it.

**In operation**, it becomes a standing recommendation flow:

> *"Most trades businesses your size track subcontractor insurance expiry. You don't — want me to?"*
> *"You chase once at day 45. Similar businesses chase at 30 and 37 and get paid about six days
> sooner."*
> *"You're paying for a module that 80% of businesses like yours use for asset servicing."*

Each is a `notify`-band suggestion, never an automatic change. **The system may propose a policy
change; only the owner commits one** (`ORCHESTRATOR_SPEC.md` §7.3).

---

## 5. Architecture — filter at write, not at read

The single design decision that makes this safe:

> **T2 aggregation happens at extraction time, inside the tenant's boundary. The raw never lands in
> the portfolio store.**

A pattern store that holds raw rows and filters on read is one query away from a leak, forever. A
store that only ever received counts cannot leak what it does not have.

```
tenant scope                          |  portfolio scope
--------------------------------------|--------------------------------
tasks · effects · drafts · entities   |
ground_rules · delegation_policy      |
tool_register · coverage_map          |
        ↓ extraction job              |
   [ shape + count, k-checked ]  ──────→  pattern_store (T1/T2 only)
                                       |        ↓
                                       |  onboarding defaults
                                       |  adapter roadmap
                                       |  registry proposals
                                       |  benchmark surface ──→ back to tenants
```

**k-anonymity, enforced at write:** no statistic is stored unless it derives from at least *k*
distinct tenants (start k=5, revisit with volume). A cohort below threshold is discarded, not stored
and hidden.

**Storage split follows `DATA_STANDARD`:** computed statistics are exact, auditable facts →
**Postgres**. Interpretive conclusions (*"businesses with a dedicated receptionist prefer inbound-call
triage on notify rather than auto"*) → **Mnemo at a portfolio scope**, distilled and non-attributable
only. Never *"Dave's Landscaping does X."*

---

## 6. The competitive-adjacency problem

The subtle failure, and the one most likely to be missed.

Two competing landscapers in the same city. Both are clients. Aggregate statistics with k-anonymity
still leak if the cohort is narrow enough — **"trades businesses in Port Lincoln with 200 staff"
is one company.** Vertical + geography + size band triangulates to an individual faster than
intuition suggests.

**Rules:**

- **Cohorts are defined on vertical + size band only. Never geography.** Not at any granularity —
  not state, not region.
- **No cohort below k tenants**, checked at write.
- **No pricing, margin, rate or win-rate statistics cross at all**, even aggregated. These are the
  commercial positions clients would most object to informing a competitor's, and no anonymisation
  makes a rate benchmark safe when a rival can act on it.
- **A tenant may exclude itself** from contribution while still receiving benchmarks. It costs
  almost nothing at scale and it removes the objection entirely.

This is not a legal-privacy question so much as a trust question, and the trust failure is
business-ending in a way a technical breach might not be. *"Did you use my numbers to help my
competitor quote?"* has to have an answer that is structurally, not merely procedurally, no.

---

## 7. Consent and disclosure

- **Named in the privacy policy** — what is collected, that it is aggregated, that content never
  crosses, and who the subprocessors are (`REGULATORY_INCLUSIONS` I1, and the policy must describe
  the stores `DATA_STANDARD` §1 actually uses, including Mnemo).
- **Reciprocal by design.** The benchmark surface (§4) *is* the consideration. Presenting it as
  *"you contribute anonymised patterns, you receive benchmarks"* is an honest trade an owner would
  accept; burying it in a clause is not.
- **Opt-out available, benefits retained.** See §6.
- **Whose entity is disclosing this** follows the same white-label gate as everything else — a
  distributor-branded deployment discloses under the distributor's identity, and whether their
  tenants' patterns pool with ours at all is a contract term, not an assumption.

---

## 8. Why this compounds — the strategic read

Each new client makes the next one cheaper to onboard. By client twenty, Kira arrives at the hour
already knowing what a business of that shape runs, what is probably missing, what limits owners like
them set, and which chase wording works. Client one is expensive; client twenty is nearly free.

That is a moat that **grows with usage and cannot be bought** — the build/buy analysis in
`EXECUTION_LAYER.md` §14 identified the delegation model and the registry as the unpurchasable
assets; this is the mechanism by which both get better without anyone writing them.

It is also the North Star pattern operating on itself: encode the methodology once, and every client
sharpens it for every other client, without Dennis being in the middle of any of it.

---

## 9. What we deliberately do not learn

- **Anything derived from client correspondence content.** The words in a chase email, a complaint,
  or a quote never leave the tenant.
- **Pricing, margins, rates, win rates.** §6.
- **Cross-tenant entity matching.** If the same supplier appears in two tenants we do not link them.
  The temptation is a "shared supplier graph"; the cost is that two clients can infer each other's
  relationships.
- **Per-employee patterns.** Aggregates are about businesses, never about named people inside them.
  Anything that could become a performance metric about an individual is out.
- **Model fine-tuning on tenant data.** Prompt improvement from abstracted shapes, yes. Weights
  trained on anyone's utterances, no.

---

## 10. Decisions

| # | Decision | Note |
|---|---|---|
| L1 | **Starting `k` for cohort suppression** | Recommend 5, revisited at volume. Below ~20 tenants, most cohorts will be suppressed — which is correct, not a bug. |
| L2 | **Is contribution opt-out or opt-in?** | Recommend opt-**out** with prominent disclosure and retained benefits. Opt-in produces a biased and useless corpus early, which is when it is needed most. |
| L3 | **Does the benchmark surface ship in MVP or later?** | Recommend the *onboarding defaults* half early (it is seeded from the portfolio archetype, not from live tenants, so it works at n=1) and the *comparison* half once k is satisfiable. |
| L4 | **Where does the pattern store live?** | Recommend the portfolio Supabase instance, separate from any tenant's. Physical separation makes the boundary auditable rather than a matter of query discipline. |
| L5 | Do distributor-deployed tenants pool with direct tenants? | ⚠️ **MOOT as of 2026-07-27.** Closed asymmetric (§11) — but the channel changed to **referral**, not distribution. There are no distributor-deployed tenants: every tenant is direct, billed by us, introduced by an accountant who never deploys or resells anything. §11 stands as the answer *if* a true distributor channel appears; today it governs an empty set. `pool_membership` still ships as a column — that was never contingent on which channel won. |

---

## 11. Pool membership — L5 resolved

**Locked 2026-07-27: distributor tenants RECEIVE from the global pool and CONTRIBUTE only to their
distributor's pool.** Contributing globally is available as a contractual opt-in, exchanged for
something real — fee reduction, co-development, early access to registry additions.

### 11.1 Why not one global pool

A distributor's tenants are **their customers**. The aggregate behaviour of that book — tool
adoption, coverage gaps, delegation norms, what is missing across their customer base — *is market
intelligence about their own market*, and arguably worth more to them than to us. Pooling it into a
store another distributor benefits from is something they will refuse, correctly, and some will be
contractually forbidden from allowing.

### 11.2 Why not isolated per-distributor pools either

k-anonymity (§5) is the constraint. A distributor with twelve customers satisfies k=5 on almost no
cohort, so strict isolation delivers nothing to exactly the small distributors we court first.

The asymmetry resolves this: they get the full benefit of everything learned everywhere, and their
book stays theirs. The commercial shape is right — **the distributor is paying us, the benefit flows
to them, the exposure does not.**

### 11.3 Per-distributor pooling is a product, not a concession

Because their pool is separate, it can be reported on:

> *"Across your book: 60% of your customers have no certificate-expiry tracking, and the ones that
> do are on spreadsheets."*

That is a report a distributor would value on its own, and it exists **only** because the pool is
scoped to them. What looked like a restriction is a second deliverable.

### 11.4 What is carried, from day one

```
tenant.pool_membership = {
  contributes_to: [pool_id, ...],
  receives_from:  [pool_id, ...]
}
```

…and a **membership record on every extracted statistic** — which pools contributed to this number.

**Carry both even while there is exactly one pool and everyone is in it.** The reasons this cannot
wait, in ascending order of severity:

1. **It is a term-sheet item.** A distributor's legal team asks what happens to their customers' data.
   *"We haven't decided"* either slows the deal or gets improvised under pressure — and improvised
   under pressure is how you agree to something architecturally impossible.
2. **You cannot un-pool.** Once tenant A's patterns are baked into a statistic that seeded tenant B's
   defaults, there is no extraction. The k-anonymised aggregate has no provenance *by design*.
3. **A statistic in a single-pool store carries no membership record.** Asked later *"was distributor
   X's data in this number?"*, the answer is not *"that's hard"* — the information was never
   captured. Adding pool scoping afterwards means recomputing every statistic from source, which is
   impossible once you no longer know who contributed.
4. **It collides with the white-label identity rule.** A distributor-branded deployment discloses
   under *their* identity, so *their* privacy policy describes what happens to the data
   (`REGULATORY_INCLUSIONS` Trigger A). If our default pools globally and their policy says
   otherwise, they are in breach on our behalf — relying on a fact we gave them.

### 11.5 Default for direct tenants

Direct tenants contribute to and receive from the global pool, per §7 (disclosed, reciprocal,
opt-out available with benefits retained). The global pool is therefore seeded by direct tenants and
our own operation, and grows more slowly than a single-pool design would — accepted, because the
alternative is a design no distributor signs.
