// Flow 16 — the two pure parts of the quote format, where being subtly wrong is silent.
//
// Neither of these calls a model or a database on purpose. The extraction itself is a model call and
// testing it would test the model; what is worth pinning is the coercion around it — the rule that
// decides whether a business gets ITS format or the honest generic one, and the instructions the
// drafter is handed. Both fail quietly when wrong: the quote still goes out, it is just not theirs.

import { describe, expect, it } from 'vitest';

import { parseExtractedFormat, formatAsInstructions, type StoredQuoteFormat } from './quote-format';

const stored = (structure: Partial<StoredQuoteFormat['structure']>): StoredQuoteFormat => ({
  version: 3,
  structure: {
    sections: ['Scope', 'Price', 'Terms'],
    priceExpression: null,
    taxTreatment: null,
    signOff: null,
    toneNotes: null,
    conventions: [],
    ...structure,
  },
  sourceFiles: [],
  sampleExcerpt: null,
  confirmedAt: null,
  extractedAt: '2026-08-11T00:00:00Z',
});

describe('parseExtractedFormat — no sections means NO format', () => {
  it('refuses an empty extraction rather than storing an empty shape', () => {
    // The important one. Storing `{sections: []}` would put a confident-looking empty structure in
    // front of the drafter and permanently suppress the fallback to the generic quote — so every
    // future quote would be shaped by nothing while the system reported it had their format.
    expect(parseExtractedFormat({ sections: [] })).toBeNull();
    expect(parseExtractedFormat({})).toBeNull();
    expect(parseExtractedFormat({ sections: 'Scope, Price' })).toBeNull();
  });

  it('drops blank section names rather than keeping a hole in the order', () => {
    expect(parseExtractedFormat({ sections: ['Scope', '', 'Price'] })?.sections).toEqual(['Scope', 'Price']);
  });

  it('keeps a real extraction whole', () => {
    const f = parseExtractedFormat({
      sections: ['Introduction', 'Scope of works', 'Investment', 'Next steps'],
      priceExpression: 'line items with unit rates',
      taxTreatment: 'exclusive',
      signOff: 'Kind regards, <name>',
      toneNotes: 'Plain and direct.',
      conventions: ['Valid 30 days', '20% deposit'],
    });
    expect(f?.sections).toHaveLength(4);
    expect(f?.taxTreatment).toBe('exclusive');
    expect(f?.conventions).toEqual(['Valid 30 days', '20% deposit']);
  });

  it('nulls a field the samples did not show instead of inventing one', () => {
    // "unstated" is a real answer about a business. Defaulting tax to "exclusive" because most
    // businesses are would put "plus GST" on a quote from one that is not.
    const f = parseExtractedFormat({ sections: ['Scope'], taxTreatment: 42 });
    expect(f?.taxTreatment).toBeNull();
    expect(f?.priceExpression).toBeNull();
    expect(f?.conventions).toEqual([]);
  });
});

describe('formatAsInstructions — what the drafter is actually told', () => {
  it('always states the section order, because that is the format', () => {
    expect(formatAsInstructions(stored({}))).toContain('Scope → Price → Terms');
  });

  it('omits fields that are null rather than asserting a blank one', () => {
    // "Tax: amounts are null" in a prompt is worse than silence — the model will act on it.
    const text = formatAsInstructions(stored({}));
    expect(text).not.toContain('null');
    expect(text).not.toContain('Tax:');
    expect(text).not.toContain('Close with:');
  });

  it('includes each field once it exists', () => {
    const text = formatAsInstructions(
      stored({ taxTreatment: 'inclusive', signOff: 'Regards, <name>', conventions: ['Valid 30 days'] }),
    );
    expect(text).toContain('amounts are inclusive');
    expect(text).toContain('Regards, <name>');
    expect(text).toContain('Valid 30 days');
  });

  it('forbids copying client or price detail out of their past quotes', () => {
    // The instruction exists because the samples in context are real quotes to real clients, and a
    // model given them without this will happily reuse a name or a number from one.
    expect(formatAsInstructions(stored({}))).toMatch(/only the shape/i);
  });
});
