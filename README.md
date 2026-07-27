# Orchestrator

The thing that decides **what should happen and who must approve it**, for the ~140 flows in
`TASK_REGISTRY.md`. Kira is one caller of it, not its owner.

**Status:** foundation. The canonical store and the wire contract exist; the scheduler, handlers and
connectors do not yet. See *Build order* below for what lands next and why in that sequence.

---

## Why this is a separate repo

So it can be **unplugged**. If Gareth's swarm — or a vendor, or a rewrite — turns out to be better
than ours, swapping it must be a config change in the caller, not a rewrite of the caller.

That only holds if the seam is a **network contract** rather than shared types. A replacement has to
match JSON on the wire and nothing else. `src/contract.ts` is that contract, versioned from its first
line.

```
Kira                                Orchestrator (this repo, own DB)
────                                ───────────────────────────────
getSwarmCoordinator()
  └─ OrchestratorAdapter  ──HTTP──▶  POST /v1/dispatch
       (implements             ◀────  { taskGroupId, status, draft? }
        SwarmCoordinator)
                          callback ▶  POST <caller>/task-events

Swap = KIRA_SWARM_ADAPTER + a base URL.
```

Kira already routes **every** doable intent through `SwarmCoordinator` and handles three owned kinds
(`quote`/`email`/`reminder`) locally in `LocalSwarmStub`. The adapter implements the same three
methods over HTTP, so Kira's call sites do not change when this is plugged in.

---

## The two halves of the data layer

> **We own our own records completely, and nobody else's business records at all.**

**The entity index** (`entities`, `entity_aliases`) is **projected by default**. The business already
runs Xero, and probably Simpro or ServiceM8; those systems own the contacts, jobs, quotes and
invoices and own them well. Being the system of record turns every conversation into a
rip-and-replace, which is the hardest sale there is. So we hold a stable local id, enough attributes
to resolve a name / resolve a gate band / fire a threshold, and a pointer home. Two tables, not
fourteen. `authoritative` mode is the fallback for what nobody else holds — compliance documents,
certificate expiries, contract obligations, follow-up state.

**Our operational records** (`tasks`, `task_events`, `effects`, `drafts`, `approvals`,
`delegation_policy`, `unroutable_requests`) we own outright, because nobody else does.

### The rule that keeps a projection safe

> **Sweep the projection to find candidates. Confirm against the system of record before emitting an
> effect.**

Detection from the projection, decision from the source. One API call at the point where it matters,
and it removes the entire class of stale-and-embarrassing actions — chasing an invoice the client
paid this morning. Where the source is unreachable the task fails to the review queue with the
reason; degrade, don't fake.

---

## The delegation policy is data, not code

One tenant policy governs all 140 flows. The alternative — a gate per flow — means editing 140 rows
to change one threshold, and then nobody can answer *"what can this system do without asking me?"*
without reading all of them.

Bands resolve from properties of the **action** — consequence, spend, counterparty — never from the
flow's identity. A $60 top-up and a $60k order are the same flow and must gate differently.

Applied literally, *"nothing that leaves the business goes without approval"* catches ~35 flows here,
several firing daily. The owner stops reading the queue inside a week, and **an unread queue is worse
than no queue** because it launders unreviewed output as approved. So confirmations, review requests
and tracking notifications land in `notify`; quotes, invoices, escalations and negotiated discounts
stop and wait.

`reserved` is never delegable at any authority level: payroll disbursement, tax lodgement,
termination, **supplier bank-detail change**, bad-debt write-off, capital purchase. The bank-detail
case is the sharpest — low volume, catastrophic, and the whole attack is convincing someone it is
routine, so it must not be reachable by a limit that widens with trust.

Starting figures are deliberately conservative and live in `delegation_policy.bands` as tenant
config. They are cheap to change once a real owner says the queue is too noisy or too quiet; the
model is settled, only the numbers are open.

---

## Build order

Frequency × repeatability, **not** tier. The ~20 agentic flows will eat most of the engineering and
are mostly quarterly; ~45 mechanical and conversational flows fire multiple times a week each.

1. **Canonical store** ✅ `db/001_canonical_store.sql`
2. **Generalise the sweeper** — one mechanism, twenty flows:
   `sweep canonical rows → past a threshold → compose from template + context → gate → send`.
   Kira's reminder scheduler is this pattern with a single row type; the work is widening it to read
   `entities` and to carry rules. Exercises the task table, the state machine, the gate machinery and
   the review queue on real data **with no model in the routing path**.
3. **Delegation policy** — the bands, so step 2's twenty flows do not all demand approval.
4. **First connector: email-send** (~50 flows), then accounting (~30).
5. **Agents / tools mix** so the registry flows go live.

## Open

- **No database is provisioned yet.** This schema needs its own Supabase project — deliberately not
  Kira's, or "unplug and replace" quietly becomes "unpick our tables from theirs".
- Manifest expansion order: the twenty flows above, then quoting (16, 33), then debtors (45–48,
  107–112).
- Whether `H`/assisted is a tier or a flag. Recommend tier — it is a routing decision, and it must
  never execute.
