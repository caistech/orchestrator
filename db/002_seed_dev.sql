-- Development seed — a dataset the sweeper can actually be run against, end to end.
--
-- WHY SYNTHETIC RATHER THAN REAL, given tenant zero (Global Buildtech Australia) has live Xero,
-- Drive and Gmail we own outright: real data does not reliably contain the edge you need. To prove
-- "chase a 30-day overdue account" fires you need an invoice that is exactly 31 days overdue at the
-- moment you run it, and one that is 29 days overdue that must NOT fire. You cannot ask a real
-- ledger for that. So the mechanism is proven here, and the CONNECTORS are proven against GBA —
-- they are different jobs and neither substitutes for the other.
--
-- Every row is dated RELATIVE TO now(), so this seed stays meaningful whenever it is run rather than
-- rotting into a table where every threshold has long since passed.
--
-- Shaped on the avatar (TASK_REGISTRY §1): dual-channel, holds inventory, does field work,
-- multi-site. Names are invented; any resemblance to GBA's actual customers is not intended.
--
-- Safe to re-run: deletes the seed tenant and rebuilds it. NEVER point this at a tenant carrying
-- real data — it is keyed on a fixed uuid precisely so it cannot wander onto one by accident.

BEGIN;

-- The fixed seed tenant. A literal uuid, so re-running replaces the seed and can never collide with
-- a real tenant created by the application.
DELETE FROM tenants WHERE id = '00000000-0000-4000-a000-000000000001';

INSERT INTO tenants (id, name, timezone)
VALUES ('00000000-0000-4000-a000-000000000001', 'Seed Trading Co (dev)', 'Australia/Perth');

-- ─────────────────────────────────────────────────────────────────────────────
-- Entities — each one exists to make a specific sweep rule fire, or deliberately NOT fire.
-- The near-miss rows are the point: a sweeper that fires on everything is not a sweeper.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO entities (tenant_id, kind, mode, source_system, source_id, synced_at,
                      display_name, email, phone, account_type, value_band,
                      days_overdue, last_contacted_at, expires_on, attributes)
VALUES
  -- flow 45 — chase 30-day overdue. FIRES (31 days).
  ('00000000-0000-4000-a000-000000000001','invoice','projected','xero','INV-1001', now(),
   'INV-1001 Ellis Plumbing','dave@example.invalid',NULL,'trade','mid',
   31, now() - interval '31 days', NULL,
   '{"amount": 4820.00, "currency": "AUD", "customer": "Ellis Plumbing"}'::jsonb),

  -- flow 45 — the NEAR MISS (29 days). Must NOT fire. If it does, the threshold is wrong.
  ('00000000-0000-4000-a000-000000000001','invoice','projected','xero','INV-1002', now(),
   'INV-1002 Harbour Fitout','accounts@example.invalid',NULL,'trade','mid',
   29, now() - interval '29 days', NULL,
   '{"amount": 1290.00, "currency": "AUD", "customer": "Harbour Fitout"}'::jsonb),

  -- flow 46 — escalate 60/90. FIRES, and must escalate rather than send the 30-day template.
  ('00000000-0000-4000-a000-000000000001','invoice','projected','xero','INV-0918', now(),
   'INV-0918 Northline Group','ap@example.invalid',NULL,'trade','high',
   67, now() - interval '67 days', NULL,
   '{"amount": 18750.00, "currency": "AUD", "customer": "Northline Group"}'::jsonb),

  -- flow 45 — PAID SINCE LAST SYNC. The projection still says 34 days overdue; the source says
  -- settled. This row exists to prove detection-versus-decision: the sweep must pick it up and the
  -- CONFIRM step must drop it before an effect is emitted. Chasing this invoice is the single most
  -- embarrassing thing the system can do.
  ('00000000-0000-4000-a000-000000000001','invoice','projected','xero','INV-0977', now() - interval '2 days',
   'INV-0977 Cassidy Bros','pay@example.invalid',NULL,'trade','mid',
   34, now() - interval '34 days', NULL,
   '{"amount": 2410.00, "currency": "AUD", "customer": "Cassidy Bros", "_dev_source_truth": "PAID", "_dev_note": "projection stale on purpose"}'::jsonb),

  -- flow 9 — chase a lead that went quiet (> 14 days). FIRES.
  ('00000000-0000-4000-a000-000000000001','contact','projected','hubspot','C-5521', now(),
   'Marla Whitfield','marla@example.invalid','+61400000001','consumer','low',
   NULL, now() - interval '23 days', NULL,
   '{"stage": "quoted", "source": "web form"}'::jsonb),

  -- flow 19 — quote follow-up at day 3/7/14. FIRES at the day-7 step.
  ('00000000-0000-4000-a000-000000000001','quote','projected','simpro','Q-3390', now(),
   'Q-3390 Westgate Yard slab','ops@example.invalid',NULL,'trade','high',
   NULL, now() - interval '7 days', NULL,
   '{"amount": 46200.00, "currency": "AUD", "sent_at_days_ago": 7}'::jsonb),

  -- flow 83 / +127 / +130 — expiry sweeps at −30 days. One FIRES (expires in 12 days),
  -- one does NOT (expires in 210 days).
  ('00000000-0000-4000-a000-000000000001','subcontractor','authoritative',NULL,NULL,NULL,
   'Kowalski Electrical','admin@example.invalid','+61400000002','trade','mid',
   NULL, NULL, (now() + interval '12 days')::date,
   '{"document": "public liability insurance", "policy": "PL-88213"}'::jsonb),

  ('00000000-0000-4000-a000-000000000001','subcontractor','authoritative',NULL,NULL,NULL,
   'Ridgeway Concreting','office@example.invalid','+61400000003','trade','mid',
   NULL, NULL, (now() + interval '210 days')::date,
   '{"document": "public liability insurance", "policy": "PL-77410"}'::jsonb),

  -- flow 56 — reorder stock at minimum. FIRES. Deliberately a $60-ish reorder so it sits in a
  -- DIFFERENT delegation band from the $46k quote above — same class of action, different money.
  ('00000000-0000-4000-a000-000000000001','sku','projected','simpro','SKU-4410', now(),
   '20mm elbow (box of 50)',NULL,NULL,NULL,'low',
   NULL, NULL, NULL,
   '{"on_hand": 3, "minimum": 10, "unit_cost": 1.20, "reorder_value": 60.00}'::jsonb),

  -- flow 67 — reawaken a client quiet 6 months. FIRES.
  ('00000000-0000-4000-a000-000000000001','account','projected','xero','ACC-220', now(),
   'Tamworth Rural Supplies','buyer@example.invalid','+61400000004','trade','high',
   NULL, now() - interval '8 months', NULL,
   '{"lifetime_value": 184000.00, "currency": "AUD"}'::jsonb);

-- Aliases — "chase Dave" has to resolve to a row without semantic-searching the client list
-- (ORCHESTRATOR_SPEC §9 retrieval pattern: resolve to a canonical entity FIRST).
INSERT INTO entity_aliases (entity_id, alias)
SELECT id, a.alias FROM entities,
  LATERAL (VALUES ('Dave'),('Dave Ellis'),('Ellis')) AS a(alias)
WHERE source_id = 'INV-1001' AND tenant_id = '00000000-0000-4000-a000-000000000001';

-- ─────────────────────────────────────────────────────────────────────────────
-- Delegation policy — conservative starting figures, as tenant config (TASK_REGISTRY §7, §8.1).
-- These numbers are a starting point, not a finding. They get moved the first time a real owner
-- says the queue is too noisy or too quiet.
--
-- The band for each action follows the registry's OWN Gate column, not intuition: 45 (chase a
-- 30-day account) is `N`, 46 (escalate 60/90) is `S`. That split looks odd until you count — a
-- routine 30-day reminder fires several times a week and gating it is how the queue dies, while an
-- escalation names a deadline and is a different conversation with the same customer.
--
-- The first sweep run had five of seven actions falling through to "not in any band", which the
-- gate correctly defaulted to ask. Safe, but it meant the policy was governing almost nothing —
-- exactly the over-gating §7 warns about, arrived at by omission rather than by decision. An action
-- a rule can emit and the policy has never heard of is a gap, not a default.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO delegation_policy (tenant_id, version, bands, reserved)
VALUES ('00000000-0000-4000-a000-000000000001', 1,
  '{
    "notify": {
      "why": "no money, no commitment, reversible — high volume, and gating these kills the queue",
      "actions": ["appointment.confirm","review.request","satisfaction.check","dispatch.notify",
                  "internal.announce","debt.chase","quote.followup","compliance.expiry"]
    },
    "approve_before_send": {
      "why": "reaches a customer and commits us to something",
      "actions": ["quote.send","invoice.send","debt.escalate","discount.offer","contract.send",
                  "lead.chase","client.reawaken"]
    },
    "approve_before_start": {
      "why": "money leaves",
      "spend_threshold_aud": 500,
      "actions": ["purchase.order","stock.reorder","supplier.pay"]
    }
  }'::jsonb,
  '["76","81","80","134","112","100"]'::jsonb);

COMMIT;

-- Expected first sweep against this seed (the acceptance criteria for step 2):
--   FIRES  : INV-1001 (45), INV-0918 (46, escalated), Marla Whitfield (9), Q-3390 (19),
--            Kowalski Electrical (127), SKU-4410 (56), Tamworth Rural (67)
--   SILENT : INV-1002 (29 days — under threshold), Ridgeway Concreting (210 days out)
--   DROPPED AT CONFIRM : INV-0977 (projection stale; source says PAID)
--   BANDS  : SKU-4410 reorder is $60 → under the 500 threshold → auto; Q-3390 → approve_before_send
