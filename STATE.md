# Orchestrator — state of play

**As at 2026-07-28.** Written so a cold session can resume without re-deriving anything.

---

## What this is

Decides **what should happen and who must approve it**, across the 140-flow registry
(`TASK_REGISTRY.md`). Kira is one caller, not the owner. Its own repo and its own database
deliberately, so it can be **unplugged and replaced** (Gareth's swarm, a vendor) by changing
`KIRA_SWARM_ADAPTER` and a base URL — which only holds because the seam is a **wire contract**
(`src/contract.ts`), not shared types.

## Coordinates

| | |
|---|---|
| Repo | `github.com/caistech/orchestrator` (private) |
| Supabase | ref `xuzvurmprexhalnxgsdu`, `ap-southeast-2` · db password → `~/.orchestrator-db-pass` |
| Vercel | project `orchestrator`, team `corporate-ai-solutions` (`prj_jHqRPUYBJhnlI9CSGNf35iYALocL`) |
| Stable URL | the `orchestrator-corporate-ai-solutions.vercel.app` alias (re-alias after every deploy) |
| Secrets | `~/.orchestrator-secrets` (ORCHESTRATOR_SECRET, callback secret), `.env.local` (gitignored) |
| Manifest | registered in `cais-shared-services/portfolio-manifest.yaml` |

⚠️ **Vercel SSO deployment protection is OFF, deliberately.** `/unsubscribe` is printed in real
emails and `/api/v1/dispatch` is called machine-to-machine; an SSO wall breaks both. The app gates
itself.

## Built and working

1. **Canonical store** (`db/001`) — entity INDEX (projected by default; Xero owns the invoice, we
   hold a stable id + resolution/gate/sweep attributes + a pointer home) plus our own operational
   records. RLS on all tables, service-role only.
2. **Sweeper** (`src/sweeper.ts`) — `sweep → threshold → CONFIRM → compose → gate → emit`. Seven
   rules as DATA in `src/rules.ts`. Idempotent per (flow, entity, day).
3. **Delegation gate** (`src/gate.ts`) — bands resolve from the ACTION (consequence, spend,
   counterparty), never the flow. `reserved` never delegable. Unknown actions HOLD.
4. **Email connector** (`src/connectors/email.ts`) — claim → send → record. Sends as the TENANT
   (their ABN, from `tenants`), never ours. Commercial mail refused until an unsubscribe URL is
   configured. **Proven live: 3 sent via Resend.**
5. **Xero connector** (`src/connectors/xero.ts`) — sync as detection, `XeroSourceConfirmer` as
   decision. **Live against Global Buildtech: 7 invoices + contact emails.**
6. **App** — `/queue` (review), `/tasks`, `/connections`, `/settings`, `/login`, `/unsubscribe`,
   `/api/v1/dispatch` + `/api/v1/tasks/:id/approve`, crons for sweep (hourly) + drain (15 min).
7. **Auth (2026-07-28)** — Supabase magic-link + `ADMIN_EMAILS` allowlist, per-person sessions, real
   Sign Out, self-service signup disabled. Replaced a shared-secret cookie whose value WAS the
   secret. Operator chrome applied in the LAYOUT so a new page cannot ship without it.

**Gating verified live:** `/`, `/queue`, `/settings`, `/tasks`, `/connections` → 307 to login;
`/login`, `/unsubscribe`, `/no-access` → 200. All 5 security headers present.

## The two safeguards protecting real customers RIGHT NOW

Real GBA invoices are in `entities` with real customer emails. What stops mail reaching them:

1. **GBA has no `delegation_policy` row**, so every action resolves to "defaulting to ask" and holds.
   0 tasks, 0 effects for that tenant.
2. **Both cron routes are pinned to `SEED_TENANT`** — the schedule only ever touches the dev tenant.

⚠️ **(2) is a safeguard by construction, not by intent.** It protects only because a constant points
elsewhere. Whoever makes GBA live will change one import and silently enable the schedule against a
real ledger. **The tenant list belongs in config with an explicit per-tenant `live` flag — fix this
BEFORE GBA is meant to run on the schedule.**

## Open findings (clean naive-tester run, Connor, 2026-07-28)

- ✅ **Fixed:** open redirect on login · no Sign Out · missing security headers · unconfirmed
  Approve-and-send · cookie-as-secret (auth rebuild)
- ❌ **Open:** none from that run — but it was run against the OLD auth. **A re-run is required**;
  the gate has no recorded PASS.

## Known gaps / next

1. **Per-tenant `live` flag** before GBA goes on the schedule (see above).
2. **Suppliers not modelled** — flow 56 (reorder) refuses for want of a recipient, correctly.
3. **13 of the 20 §6 rules unwritten** — they need entity kinds no connector feeds yet.
4. **`UNSUBSCRIBE_BASE_URL` unset**, so commercial mail is refused. Set it when happy with the page.
5. **Delegation bands for GBA** — deliberately unset. Two invoices are 500+ days overdue at $11k.
6. **GBA Xero cleanup** — parked by the operator until Kira/orchestrator work completes.
7. Sequence from `README.md`: step 3 (bands as a real surface) then more connectors.

## Commands

```bash
npm run sweep -- --tenant <uuid> --dry-run   # decide, write nothing  (ALWAYS use for GBA)
npm run sweep                                # dev tenant, writes
npm run drain -- --dry-run                   # outbox, send nothing
npm run drain -- --redirect you@real.com     # send for real, to yourself
npm run xero:sync                            # pull GBA invoices into entities
```

Migrations apply via the Supabase Management API (`~/.supabase-token`), never a blind `db push`.

## THE SEAM IS CONNECTED AND PROVEN (2026-07-28, late)

Kira now calls this orchestrator, and this orchestrator calls back.

- `GET /v1/tasks/:id` — the poll leg, for a caller that cannot receive a push.
- `src/callback.ts` `notifyCaller` — the push leg, fired by the email connector on **send AND
  failure**. Fail-soft: the mail has already left, so a down caller must never make a successful
  send look failed. Uses `CALLBACK_URL` + `CALLBACK_SECRET`, a **separate** secret from the inbound
  one — inbound proves the caller to us, this proves us to the caller, and one shared value would
  let either side's leaked env forge completions.
- Kira's half: `lib/kira/swarm/orchestrator-adapter.ts` + `/api/kira/webhooks/task-events`.

**Harness: `kira/scripts/test-task-loop.mjs`, 10/10 against production.** Asserts the negatives —
no secret, wrong secret, forged callback, unsigned poll all refused — because a happy-path-only test
would pass straight through a silent failure. Verified the completion landed in `kira_tasks`, not
merely that it returned 200.

⚠️ **Kira's `KIRA_SWARM_ADAPTER` is deliberately unset**, so production Kira still uses its local
stub. The wire is proven; routing a real owner through it is a separate decision.

## TODO — the agent builder (operator, 2026-07-28)

When a task or flow arrives that **no existing agent can do**, the system needs to spin one up.
`unroutable_requests` is already the input: it exists so what could not be routed is recorded rather
than dropped, and ORCHESTRATOR_SPEC §5 calls it the source of truth for where the real decomposition
boundaries are. **That table is the agent builder's backlog** — the phrases in it are the flows the
registry does not yet cover. Maps to Seam 4 in Kira's `docs/GARETH_SHAH_INTEGRATION_SEAMS.md`.
