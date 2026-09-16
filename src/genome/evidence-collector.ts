// The evidence collector — maps completed effects to genome evidence.
//
// AGENTIC_NETWORK.md §2: "Evidence Collector (src/genome/evidence-collector.ts) — effect→bucket
// mapping, staging first."
//
// §4: "The Genome is not written by agents. Evidence flows through a staging/review area and a
// bucket moves only on evidenced pathway milestones."
//
// WHY STAGING, NOT DIRECT WRITES. The Genome is the product (PROJECT_STATUS: "Learning — the
// process of refining the Business Genome — IS the product"). An agent that auto-edits the
// Genome would bypass the governance process that makes it trustworthy. Evidence lands in
// `evidence_staging` first, reviewed by a human before promotion to the Genome.
//
// This is a PURE computation module — given an effect and the mapping, it produces staging
// rows. The caller (run-agents.ts) persists them to the DB.

import type { SupabaseClient } from '@supabase/supabase-js';

// ── The mapping: effect.kind → genome bucket ───────────────────────────────────────────────────
//
// Each completed effect maps to one or more genome buckets. The mapping is derived from what the
// effect PROVES about the business: a sent quote proves the quoting SOP exists and is followed;
// a chased invoice proves the debtor management SOP exists. The bucket names must match the
// Business Genome's bucket structure (Kira-side).

export interface EvidenceMapping {
  /** The effect kind this mapping applies to. */
  effectKind: string;
  /** The genome bucket(s) this evidence supports. */
  genomeBuckets: string[];
  /** Human-readable description of what this evidence proves. */
  description: string;
  /** The maturity level this evidence contributes to (0-7). Higher = more systemised. */
  maturityLevel: number;
}

/**
 * The canonical mapping. Derived from the TASK_REGISTRY's 140 flows and the Genome's bucket
 * structure. When a new effect kind is added, this mapping must be extended — check:agents
 * will flag an unmapped kind.
 */
export const EVIDENCE_MAPPINGS: EvidenceMapping[] = [
  // ── Quote lifecycle ─────────────────────────────────────────────────────────────────────
  {
    effectKind: 'email.send',
    genomeBuckets: ['communication', 'client_management'],
    description: 'Outbound communication sent — proves the follow-up and correspondence SOP exists.',
    maturityLevel: 2,
  },
  {
    effectKind: 'email.draft',
    genomeBuckets: ['communication'],
    description: 'Email drafted — proves the drafting SOP exists but awaiting human approval.',
    maturityLevel: 1,
  },
  // ── Compliance ──────────────────────────────────────────────────────────────────────────
  {
    effectKind: 'compliance.expiry',
    genomeBuckets: ['compliance', 'risk_management'],
    description: 'Compliance expiry detected — proves the expiry-tracking SOP exists.',
    maturityLevel: 3,
  },
  // ── Financial ───────────────────────────────────────────────────────────────────────────
  {
    effectKind: 'debt.chase',
    genomeBuckets: ['financial_management', 'cash_flow'],
    description: 'Debt chase sent — proves the debtor management SOP exists and fires on time.',
    maturityLevel: 3,
  },
  {
    effectKind: 'debt.escalate',
    genomeBuckets: ['financial_management', 'risk_management'],
    description: 'Debt escalated — proves the escalation SOP exists for aged receivables.',
    maturityLevel: 4,
  },
  // ── Operations ──────────────────────────────────────────────────────────────────────────
  {
    effectKind: 'stock.reorder',
    genomeBuckets: ['operations', 'supply_chain'],
    description: 'Stock reorder triggered — proves the reorder-point SOP exists.',
    maturityLevel: 3,
  },
  {
    effectKind: 'lead.chase',
    genomeBuckets: ['sales', 'client_management'],
    description: 'Lead follow-up sent — proves the lead-management SOP exists.',
    maturityLevel: 2,
  },
  {
    effectKind: 'quote.followup',
    genomeBuckets: ['sales', 'communication'],
    description: 'Quote follow-up sent — proves the quote-chasing SOP exists.',
    maturityLevel: 2,
  },
  {
    effectKind: 'client.reawaken',
    genomeBuckets: ['sales', 'client_management'],
    description: 'Client reawakening sent — proves the dormant-client SOP exists.',
    maturityLevel: 2,
  },
];

// ── Staging record ────────────────────────────────────────────────────────────────────────────

export interface EvidenceStaging {
  tenantId: string;
  taskId: string;
  effectId: string;
  effectKind: string;
  genomeBucket: string;
  description: string;
  maturityLevel: number;
  /** The completed effect's request payload — the raw evidence. */
  evidence: Record<string, unknown>;
  /** Staging status: pending review. */
  status: 'pending';
}

/**
 * Given a completed effect and its associated task, produce staging records for the Genome.
 *
 * Returns an empty array when the effect kind has no mapping — not every effect is Genome
 * evidence. Unmapped kinds are silently skipped; the ratchet still runs on them because the
 * ratchet tracks task outcomes, not Genome writes.
 */
export function collectEvidence(
  effect: {
    id: string;
    task_id: string;
    kind: string;
    request: Record<string, unknown>;
  },
  task: {
    tenant_id: string;
    payload?: Record<string, unknown>;
  },
): EvidenceStaging[] {
  const mapping = EVIDENCE_MAPPINGS.find((m) => m.effectKind === effect.kind);
  if (!mapping) return [];

  return mapping.genomeBuckets.map((bucket) => ({
    tenantId: task.tenant_id,
    taskId: effect.task_id,
    effectId: effect.id,
    effectKind: effect.kind,
    genomeBucket: bucket,
    description: mapping.description,
    maturityLevel: mapping.maturityLevel,
    evidence: effect.request,
    status: 'pending' as const,
  }));
}

/**
 * Persist staging records to the evidence_staging table.
 *
 * Idempotent: the (effect_id, genome_bucket) pair has a unique constraint, so duplicate
 * inserts are silently ignored. This is important because the collector may run more than once
 * for the same effect (the runner retries on transient failures).
 */
export async function persistStaging(
  supabase: SupabaseClient,
  staging: EvidenceStaging[],
): Promise<{ inserted: number; errors: number }> {
  let inserted = 0;
  let errors = 0;

  for (const row of staging) {
    const { error } = await supabase.from('evidence_staging').upsert(
      {
        tenant_id: row.tenantId,
        task_id: row.taskId,
        effect_id: row.effectId,
        effect_kind: row.effectKind,
        genome_bucket: row.genomeBucket,
        description: row.description,
        maturity_level: row.maturityLevel,
        evidence: row.evidence,
        status: row.status,
      },
      { onConflict: 'effect_id,genome_bucket', ignoreDuplicates: true },
    );

    if (error) {
      console.error(`[evidence] staging insert failed for ${row.effectKind}→${row.genomeBucket}:`, error);
      errors += 1;
    } else {
      inserted += 1;
    }
  }

  return { inserted, errors };
}
