// Flow 14a — "what did this material cost us last time?"
//
// The sibling of past-pricing, and the distinction between them is the whole point of this file.
//
//   past-pricing  what we CHARGED a client       → informs the price
//   material-cost what we PAID a supplier        → informs the cost
//
// Confusing the two is not a rounding error, it is quoting at cost, and it is the single most
// expensive mistake this kind of assistance can make. A model handed a list of supplier prices and
// asked to write a quote will happily use them as the quote, because they are the only numbers on
// the page. The refusal below is written for exactly that, and it is stronger than past-pricing's.
//
// ⚠️ WHAT THIS HONESTLY IS. Flow 14 in the registry says "look up CURRENT input and material costs".
// This answers "what we last PAID", which is not the same thing — steel moves, and a bill from March
// is evidence rather than a rate. There is no current-rate source connected (no supplier price list,
// no trade-account API), so the current half is not built rather than approximated. Saying "this is
// what you paid on 14 March" is useful and true; presenting it as today's rate would not be.

import type { SupabaseClient } from '@supabase/supabase-js';

export interface MaterialCost {
  /** The supplier's own wording from the bill line. Never re-described by us. */
  description: string;
  /** Per-unit, as billed. Null when the bill did not break it out. */
  unitAmount: number | null;
  quantity: number | null;
  supplier: string | null;
  /** The bill date — the reason this is evidence rather than a rate. */
  when: string | null;
}

interface BillRow {
  display_name: string;
  attributes: Record<string, unknown> | null;
}

/**
 * How many bills to scan.
 *
 * The line items live inside each bill's `attributes`, so this reads rows and filters in JS rather
 * than reaching into jsonb from SQL. That is fine at this bound and honest about it: a business with
 * 4,000 bills gets the most recent 200 searched, not all of them. Widening it is a query change, not
 * a rewrite — but it should be a decision someone makes, not a default that quietly degrades.
 */
const BILL_SCAN_LIMIT = 200;

/** Enough to see what a thing costs; more is noise in a prompt. */
const DEFAULT_LIMIT = 6;

const STOP = new Set(
  ('the a an and or for to of with on at in from about need needs some more much cost costs price ' +
    'prices buy buying order please can you we our us how what')
    .split(' '),
);

export function materialTerms(text: string): string[] {
  return [
    ...new Set(
      (text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3 && !STOP.has(w)),
    ),
  ].slice(0, 6);
}

/**
 * Line items across recent supplier bills that mention the material.
 *
 * Returns [] on every failure path. A quote must not fail to draft because a cost lookup was
 * unavailable — the owner gets the draft without it, which is degraded and honest.
 */
export async function findMaterialCost(
  supabase: SupabaseClient,
  tenantId: string,
  description: string | null | undefined,
  options: { limit?: number } = {},
): Promise<MaterialCost[]> {
  const terms = materialTerms(description ?? '');
  if (terms.length === 0) return [];

  const { data, error } = await supabase
    .from('entities')
    .select('display_name, attributes')
    .eq('tenant_id', tenantId)
    .eq('kind', 'bill')
    .order('synced_at', { ascending: false, nullsFirst: false })
    .limit(BILL_SCAN_LIMIT);

  if (error) {
    console.error('[material-cost] lookup failed:', error.message);
    return [];
  }

  const found: MaterialCost[] = [];
  for (const bill of (data ?? []) as BillRow[]) {
    const attributes = bill.attributes ?? {};
    const items = Array.isArray(attributes.items) ? (attributes.items as Record<string, unknown>[]) : [];
    for (const item of items) {
      const itemDescription = typeof item.description === 'string' ? item.description : '';
      if (!itemDescription) continue;
      const haystack = itemDescription.toLowerCase();
      if (!terms.some((t) => haystack.includes(t))) continue;

      found.push({
        description: itemDescription,
        unitAmount: typeof item.unitAmount === 'number' ? item.unitAmount : null,
        quantity: typeof item.quantity === 'number' ? item.quantity : null,
        supplier: typeof attributes.supplier === 'string' ? attributes.supplier : null,
        when: typeof attributes.date === 'string' ? attributes.date : null,
      });
      if (found.length >= (options.limit ?? DEFAULT_LIMIT)) return found;
    }
  }

  return found;
}

const aud = (n: number | null) =>
  n === null ? 'no unit price on the bill' : n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });

/**
 * The costs as drafting context — with a refusal deliberately stronger than past-pricing's.
 *
 * Two separate dangers, and each needs naming or the model will fall into it. The first is quoting
 * at cost, which loses the margin on the job. The second is presenting a March bill as today's rate,
 * which is a claim about the market that nobody made.
 */
export function materialCostAsContext(rows: MaterialCost[]): string | null {
  if (rows.length === 0) return null;
  const lines = rows.map((r) => {
    const qty = r.quantity !== null ? ` ×${r.quantity}` : '';
    return `- ${r.description}${qty} — ${aud(r.unitAmount)} per unit${r.supplier ? `, from ${r.supplier}` : ''}${r.when ? ` (${r.when.slice(0, 10)})` : ''}`;
  });
  return [
    'What this business PAID SUPPLIERS for similar materials, for YOUR REFERENCE ONLY:',
    ...lines,
    '',
    'These are COSTS, not prices. They are what the business paid, and quoting a client at cost ' +
      'would give the job away. Do not put any of these figures in the quote, do not add a margin to ' +
      'one and present the result as a price, and do not describe any of them as a current rate — ' +
      'they are what was billed on the dates shown, and prices move. If the owner did not state a ' +
      'price, leave the "[$amount]" placeholder exactly as instructed.',
  ].join('\n');
}
