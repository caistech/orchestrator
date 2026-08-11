// Flow 14a — the refusal is the test that matters here.
//
// past-pricing's figures are what we CHARGED, so the worst case is a wrong price. These are what we
// PAID, and the worst case is quoting a client at cost — which loses the margin on the whole job and
// looks entirely reasonable on the page. So this suite pins the wording harder than its sibling.

import { describe, expect, it } from 'vitest';

import { materialTerms, materialCostAsContext, type MaterialCost } from './material-cost';

const cost = (over: Partial<MaterialCost> = {}): MaterialCost => ({
  description: '90x45 H3 treated pine, 5.4m',
  unitAmount: 18.4,
  quantity: 40,
  supplier: 'Bunnings Trade',
  when: '2026-03-14T00:00:00Z',
  ...over,
});

describe('materialTerms', () => {
  it('keeps the words that name a material', () => {
    const terms = materialTerms('what does treated pine decking cost these days');
    expect(terms).toContain('treated');
    expect(terms).toContain('pine');
    expect(terms).toContain('decking');
  });

  it('drops the words that appear in every request', () => {
    const terms = materialTerms('how much does the price of some more cost');
    for (const junk of ['much', 'price', 'cost', 'some', 'more']) expect(terms).not.toContain(junk);
  });

  it('is bounded and never throws', () => {
    expect(materialTerms(Array.from({ length: 40 }, (_, i) => `mat${i}erial`).join(' ')).length).toBeLessThanOrEqual(6);
    for (const junk of ['', '   ', null, undefined]) {
      expect(() => materialTerms(junk as unknown as string)).not.toThrow();
    }
  });
});

describe('materialCostAsContext — these are COSTS', () => {
  it('returns null for nothing, rather than an empty heading to fill', () => {
    expect(materialCostAsContext([])).toBeNull();
  });

  it('says the word COSTS, and says what quoting at cost does', () => {
    const text = materialCostAsContext([cost()])!;
    expect(text).toMatch(/COSTS, not prices/);
    expect(text).toMatch(/give the job away/i);
  });

  it('forbids the three specific routes to a wrong number', () => {
    const text = materialCostAsContext([cost()])!;
    // Each is a different way to end up quoting from a cost, and naming only one leaves the others.
    expect(text).toMatch(/Do not put any of these figures in the quote/i);
    expect(text).toMatch(/do not add a margin to one/i);
    expect(text).toMatch(/do not describe any of them as a current rate/i);
  });

  it('keeps the date visible, because that is what makes it evidence rather than a rate', () => {
    expect(materialCostAsContext([cost()])!).toContain('2026-03-14');
  });

  it('shows a missing unit price as missing rather than as free', () => {
    const text = materialCostAsContext([cost({ unitAmount: null })])!;
    expect(text).toContain('no unit price on the bill');
    expect(text).not.toContain('$0.00');
  });

  it('carries the supplier and the quantity as billed', () => {
    const text = materialCostAsContext([cost()])!;
    expect(text).toContain('Bunnings Trade');
    expect(text).toContain('×40');
    expect(text).toContain('$18.40');
  });
});
