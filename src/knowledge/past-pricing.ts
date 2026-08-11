// Flow 13 — "have we done this job before, and what did we charge?"
//
// The read tool that gives flow 16's quotes their NUMBERS, where the quote format gave them their
// shape. When the owner says "quote Trinh for the platform work", the two questions a human would
// ask before writing anything are: what does our quote look like, and what did we charge the last
// time we did this. The first is `quote-format.ts`. This is the second.
//
// It reads the entity index — rows a connector already put there (Xero invoices, quotes) — so it
// costs one indexed query and no model. Flow 13 is tier M in the registry for exactly that reason:
// looking up what you charged is a lookup, not a judgement, and putting a model in front of it
// would make the answer differ between Monday and Tuesday for the same history.
//
// ⚠️ THE DANGER THIS CARRIES, AND WHY THE WIRING IS DELIBERATE.
//
// Handing a model a list of past prices and asking it to write a quote is an invitation to state
// one. That is worse than the existing behaviour, not better: today an unpriced quote reaches the
// owner with a visible "[$amount]" for him to fill, and the failure is obvious. A quote carrying a
// plausible, specific, WRONG figure lifted from a job eighteen months ago is not obvious, and it
// goes to a client.
//
// So comparables are reference material for the OWNER, never a price for the model. The drafter
// instruction below says so in terms, the placeholder rule stays dominant, and what informed the
// draft is recorded on the task so a reviewer can see the same numbers the drafter saw.

import type { SupabaseClient } from '@supabase/supabase-js';

export interface Comparable {
  kind: string;
  /** What it was — the row's own display name, never a summary we invented. */
  label: string;
  /** AUD, when the row carries one. Null is a real answer and is shown as such. */
  amount: number | null;
  /** When we last touched it — the only date the index reliably holds. */
  when: string | null;
  /** 'xero' | 'manual' | … — so the owner knows where the figure came from. */
  source: string | null;
}

/** Kinds worth comparing against. An `account` or a `contact` has no price on it. */
const PRICED_KINDS = ['quote', 'invoice', 'job'];

/** Enough to see a pattern; more is noise in a prompt and cost in a query. */
const DEFAULT_LIMIT = 5;

/**
 * Words worth matching on.
 *
 * Deliberately crude: strip anything short or generic, keep the rest. The alternative — asking a
 * model which past jobs are similar — costs a call per quote and is not obviously better at it than
 * matching "platform" against "platform". Where this finds nothing, the drafter simply gets no
 * comparables, which is the honest outcome rather than a stretched one.
 */
const STOP = new Set(
  ('the a an and or for to of with on at in from about quote please can you we our us job work ' +
    'do doing done new next this that it is are was were be been need needs needed')
    .split(' '),
);

export function searchTerms(text: string): string[] {
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
 * Prior priced work for this tenant, matched on the client name and what the owner said.
 *
 * Returns [] rather than throwing on every failure path. A quote must not fail to draft because the
 * history lookup was unavailable — the owner gets the quote without the reference, which is the
 * degraded-but-honest outcome. Degrade, don't fake (DATA_STANDARD R4).
 */
export async function findComparableWork(
  supabase: SupabaseClient,
  tenantId: string,
  options: { client?: string | null; description?: string | null; limit?: number } = {},
): Promise<Comparable[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const terms = [
    ...(options.client ? [options.client.toLowerCase()] : []),
    ...searchTerms(options.description ?? ''),
  ];
  if (terms.length === 0) return [];

  // One OR'd ILIKE across display_name. `%` and `_` are escaped: a client called "50% Design" would
  // otherwise match everything, which reads as a suspiciously well-matched history.
  const escaped = terms.map((t) => t.replace(/[%_\\]/g, '\\$&'));
  const filter = escaped.map((t) => `display_name.ilike.%${t}%`).join(',');

  const { data, error } = await supabase
    .from('entities')
    .select('kind, display_name, attributes, synced_at, last_contacted_at, source_system')
    .eq('tenant_id', tenantId)
    .in('kind', PRICED_KINDS)
    .or(filter)
    .order('synced_at', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) {
    console.error('[past-pricing] lookup failed:', error.message);
    return [];
  }

  return (data ?? []).map((row) => {
    const attributes = (row.attributes ?? {}) as Record<string, unknown>;
    const amount = typeof attributes.amount === 'number' ? attributes.amount : null;
    return {
      kind: row.kind as string,
      label: row.display_name as string,
      amount,
      when: ((row.synced_at ?? row.last_contacted_at) as string) ?? null,
      source: (row.source_system as string) ?? null,
    };
  });
}

const aud = (n: number | null) =>
  n === null ? 'no figure recorded' : n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });

/**
 * The comparables as drafting context — with the instruction that stops them becoming a price.
 *
 * The warning is not decoration. Without it a model given five past figures will produce a sixth,
 * and it will look exactly as confident as one the owner dictated.
 */
export function comparablesAsContext(rows: Comparable[]): string | null {
  if (rows.length === 0) return null;
  const lines = rows.map(
    (r) => `- ${r.label} — ${aud(r.amount)}${r.when ? ` (${r.when.slice(0, 10)})` : ''}${r.source ? `, from ${r.source}` : ''}`,
  );
  return [
    'What this business has charged for similar work before, for YOUR REFERENCE ONLY:',
    ...lines,
    '',
    'These are past figures for context. They are NOT the price for this job and you must not ' +
      'present any of them as one, or average them, or adjust one into a new figure. If the owner ' +
      'did not state a price, leave the "[$amount]" placeholder exactly as instructed — a specific ' +
      'wrong number reaches the client looking every bit as certain as a right one.',
  ].join('\n');
}
