// The AU-only clearance, and the reason it is not applied to every send.
//
// PRODUCT_STANDARDS §9 requires assertJurisdictionAllowed in the send path. It shipped in
// @caistech/email-compliance 0.2.0 and was called from nowhere, so any owner could have Kira email
// any country. Found sideways while checking whether a Canadian tester could exercise the send path.
//
// The guard throws on an UNKNOWN country as well as a disallowed one, and nothing tags contacts —
// so bolting it onto every send refuses an Australian tradesman emailing an Australian client at
// @gmail.com, which is most of them. These tests pin the line that avoids that: COMMERCIAL mail is
// guarded, TRANSACTIONAL mail is not, because the second is recipient-initiated inside an existing
// relationship and exempt or consent-inferred in every regime this is about.

import { describe, expect, it } from 'vitest';

import { checkCommercialJurisdiction, countryFromEmail } from './jurisdiction';

describe('countryFromEmail — evidence only, never a guess', () => {
  it.each([
    ['bob@bobsplumbing.com.au', 'AU'],
    ['will@tictocklean.ca', 'CA'],
    ['someone@firm.co.uk', 'GB'],
    ['a@b.co.nz', 'NZ'],
    ['x@y.de', 'DE'],
    ['UPPER@CASE.COM.AU', 'AU'],
  ])('%s -> %s', (address, expected) => {
    expect(countryFromEmail(address)).toBe(expected);
  });

  it('returns null for gTLDs and free mail — genuinely undetermined, which is a real answer', () => {
    // No IP geolocation, no provider guessing, no name heuristics. Each produces a confident answer
    // that is sometimes wrong, and a wrong country here either blocks a legitimate send or waves
    // through the exact one this exists to stop.
    for (const address of ['a@gmail.com', 'b@outlook.com', 'c@example.org', 'd@company.net']) {
      expect(countryFromEmail(address)).toBeNull();
    }
  });

  it('does not throw on rubbish', () => {
    for (const junk of ['', 'not-an-address', '@', 'a@b', null, undefined]) {
      expect(countryFromEmail(junk as unknown as string)).toBeNull();
    }
  });
});

describe('checkCommercialJurisdiction — what marketing may reach', () => {
  it('allows an Australian address', () => {
    const v = checkCommercialJurisdiction('bob@bobsplumbing.com.au');
    expect(v.allowed).toBe(true);
    expect(v.country).toBe('AU');
  });

  it('BLOCKS Canada — the case that surfaced this', () => {
    const v = checkCommercialJurisdiction('will@tictocklean.ca');
    expect(v.allowed).toBe(false);
    expect(v.country).toBe('CA');
    // CASL is real and the owner is the named sender, so the breach would be his.
    expect(v.reason).toMatch(/CA address/);
  });

  it.each(['x@firm.co.uk', 'y@firma.de', 'z@company.us', 'w@biz.co.nz'])('blocks %s', (address) => {
    expect(checkCommercialJurisdiction(address).allowed).toBe(false);
  });

  it('BLOCKS an undetermined country for commercial mail', () => {
    // For a stranger receiving marketing we genuinely cannot establish the basis, so unknown is a
    // refusal — matching the package's own semantics.
    const v = checkCommercialJurisdiction('someone@gmail.com');
    expect(v.allowed).toBe(false);
    expect(v.country).toBeNull();
  });

  it('tells the owner what to do instead, in his words', () => {
    // "Jurisdiction guard: email outreach to CA contacts is BLOCKED" is written for whoever wrote
    // the guard. The person reading this is a plumber whose email did not go.
    const v = checkCommercialJurisdiction('someone@gmail.com');
    expect(v.reason).toMatch(/customer you already deal with/i);
    expect(v.reason).not.toMatch(/SUPPORTED_OUTREACH_JURISDICTIONS|guard:/i);
  });

  it('honours an added jurisdiction once its rules are configured', () => {
    // The clearance is meant to widen — after that country's consent, identification and
    // unsubscribe rules are actually implemented, not before.
    expect(checkCommercialJurisdiction('will@tictocklean.ca', ['AU', 'CA']).allowed).toBe(true);
  });
});

describe('what is deliberately NOT guarded', () => {
  it('the guard is never consulted for transactional mail', () => {
    // Asserted as documentation of the decision: the connector calls this only when
    // `request.commercial === true`. A quote the client asked for, a reply, chasing an invoice on a
    // live job — recipient-initiated, existing relationship. Guarding those would block the
    // product's ordinary work to prevent a risk that is not there, and the first casualty would be
    // an Australian owner emailing an Australian customer at gmail.
    const wouldBlock = checkCommercialJurisdiction('client@gmail.com');
    expect(wouldBlock.allowed).toBe(false); // ← which is why transactional must not reach it
  });
});
