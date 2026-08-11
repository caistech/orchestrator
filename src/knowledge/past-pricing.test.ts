// Flow 13 — the two pure parts, both of which fail quietly when wrong.
//
// A bad search term produces no comparables and the quote is merely less informed, which nobody
// notices. A missing refusal instruction produces a quote with a price on it, which a client reads
// as a number the business committed to. The second is the one worth pinning hardest.

import { describe, expect, it } from 'vitest';

import { searchTerms, comparablesAsContext, type Comparable } from './past-pricing';

const row = (over: Partial<Comparable> = {}): Comparable => ({
  kind: 'invoice',
  label: 'INV-1001 Ellis Plumbing — platform install',
  amount: 4820,
  when: '2026-06-02T00:00:00Z',
  source: 'xero',
  ...over,
});

describe('searchTerms — crude on purpose, but not useless', () => {
  it('keeps the words that identify the work', () => {
    expect(searchTerms('quote Trinh for the platform work')).toContain('platform');
  });

  it('drops filler that would match everything', () => {
    const terms = searchTerms('can you please quote for the new job we need doing');
    // Every one of these appears in half the rows in the index. Matching on them returns a
    // history that looks impressively relevant and is not.
    for (const junk of ['quote', 'please', 'need', 'doing', 'work', 'job']) {
      expect(terms).not.toContain(junk);
    }
  });

  it('drops short words and de-duplicates', () => {
    const terms = searchTerms('deck deck decking on a big deck');
    expect(terms.filter((t) => t === 'deck')).toHaveLength(1);
    expect(terms).not.toContain('big');
  });

  it('never throws on rubbish', () => {
    for (const junk of ['', '   ', '???', null, undefined]) {
      expect(() => searchTerms(junk as unknown as string)).not.toThrow();
    }
  });

  it('is bounded — a long utterance cannot become a 40-clause query', () => {
    const long = Array.from({ length: 50 }, (_, i) => `distinctword${i}`).join(' ');
    expect(searchTerms(long).length).toBeLessThanOrEqual(6);
  });
});

describe('comparablesAsContext — the figures must never become a price', () => {
  it('returns null when there is nothing to show, rather than an empty heading', () => {
    // An empty "here is what you charged before:" block invites the model to fill it.
    expect(comparablesAsContext([])).toBeNull();
  });

  it('carries the refusal WITH the figures, every time', () => {
    const text = comparablesAsContext([row()])!;
    expect(text).toMatch(/NOT the price/i);
    expect(text).toMatch(/must not present any of them as one/i);
    // The specific failure: averaging five past jobs into a sixth number that nobody quoted.
    expect(text).toMatch(/average them/i);
    expect(text).toMatch(/\[\$amount\]/);
  });

  it('shows a missing figure as missing rather than as zero', () => {
    // "$0.00" in a pricing history is a lie about a real job. "no figure recorded" is the truth.
    const text = comparablesAsContext([row({ amount: null })])!;
    expect(text).toContain('no figure recorded');
    expect(text).not.toContain('$0.00');
  });

  it('formats money as AUD and keeps the provenance', () => {
    const text = comparablesAsContext([row()])!;
    expect(text).toContain('$4,820.00');
    expect(text).toContain('2026-06-02');
    expect(text).toContain('from xero');
  });
});
