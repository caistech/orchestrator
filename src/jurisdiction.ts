// Where does this recipient live, and are we cleared to send them marketing?
//
// PRODUCT_STANDARDS §9: email outreach is cleared for AUSTRALIA ONLY. Every other country has its
// own email-marketing law — US CAN-SPAM, Canada CASL, EU/UK GDPR+PECR — and sending commercial mail
// there before configuring it is a legal exposure. `assertJurisdictionAllowed` has shipped in
// @caistech/email-compliance since 0.2.0 and was called from nowhere.
//
// WHY IT IS NOT SIMPLY BOLTED ONTO EVERY SEND, which is the obvious reading and the wrong one:
//
// The guard throws on an UNKNOWN country as well as a disallowed one. Nothing in this system tags a
// contact with a country, so calling it on every send would refuse everything — including an
// Australian plumber emailing an Australian client whose address happens to be @gmail.com, which is
// most of them. That is not compliance, it is an outage wearing compliance as a costume, and the
// first thing it would do is make the product look broken to the owner it is meant to protect.
//
// SO IT KEYS ON `commercial`, WHICH THE EFFECT ALREADY CARRIES. That flag maps onto the actual legal
// line rather than approximating it:
//
//   COMMERCIAL — marketing, campaigns, cold outreach. This is what CASL, CAN-SPAM and PECR govern,
//     and what the AU-only clearance is about. Guarded, and an unknown country blocks, because for
//     a stranger we genuinely cannot establish the basis.
//
//   TRANSACTIONAL — a quote the client asked for, a reply, chasing an invoice on an existing job.
//     Recipient-initiated, inside an existing business relationship, which is exempt or
//     consent-inferred in every regime named above. Not guarded — guarding it would block the
//     product's ordinary work to prevent a risk that is not there.
//
// WHOSE EXPOSURE THIS IS, and it is the reason the tier is P0: the owner is the named sender. His
// entity, his ABN in the footer. A commercial send into CASL territory is HIS breach, committed by
// a tool he bought to keep him safe, and nothing tells him it happened.

/**
 * The recipient's country from the address, or null when it cannot be established.
 *
 * ccTLD only, and deliberately nothing cleverer. IP geolocation, name heuristics and provider
 * guessing all produce a confident answer that is sometimes wrong, and a wrong country here either
 * blocks a legitimate send or waves through the exact one this exists to stop. A domain suffix a
 * registry actually assigns to a country is evidence; everything else is a guess wearing evidence's
 * clothes.
 *
 * `.com`, `.org`, `.net` and the free-mail providers return null — genuinely undetermined, which is
 * a real answer and is handled as one by the caller.
 */
const CC_TLD: Record<string, string> = {
  au: 'AU',
  nz: 'NZ',
  ca: 'CA',
  uk: 'GB',
  ie: 'IE',
  de: 'DE',
  fr: 'FR',
  es: 'ES',
  it: 'IT',
  nl: 'NL',
  se: 'SE',
  no: 'NO',
  dk: 'DK',
  fi: 'FI',
  pl: 'PL',
  us: 'US',
  sg: 'SG',
  my: 'MY',
  in: 'IN',
  jp: 'JP',
  cn: 'CN',
  hk: 'HK',
  za: 'ZA',
  ae: 'AE',
  ph: 'PH',
  id: 'ID',
  vn: 'VN',
  th: 'TH',
  kr: 'KR',
  br: 'BR',
  mx: 'MX',
};

export function countryFromEmail(address: string | null | undefined): string | null {
  const at = String(address ?? '').lastIndexOf('@');
  if (at < 0) return null;
  const domain = String(address).slice(at + 1).trim().toLowerCase();
  if (!domain.includes('.')) return null;
  const suffix = domain.slice(domain.lastIndexOf('.') + 1);
  return CC_TLD[suffix] ?? null;
}

export interface JurisdictionVerdict {
  /** Whether the send may proceed. */
  allowed: boolean;
  /** ISO code when it could be established, else null. */
  country: string | null;
  /** Owner-facing reason when refused — written for him, not for a log. */
  reason?: string;
}

/**
 * May this COMMERCIAL message go to this address?
 *
 * The refusal text is what the owner reads. It says what happened and what it is about, in his
 * terms, because "Jurisdiction guard: email outreach to CA contacts is BLOCKED" is a sentence
 * written for whoever wrote the guard.
 */
export function checkCommercialJurisdiction(
  address: string,
  supported: readonly string[] = ['AU'],
): JurisdictionVerdict {
  const country = countryFromEmail(address);

  if (!country) {
    return {
      allowed: false,
      country: null,
      reason:
        `We can't tell which country ${address} is in, and marketing email is only cleared to go to ` +
        `Australian addresses at the moment. If this is a customer you already deal with, send it as ` +
        `an ordinary message rather than a campaign and it will go.`,
    };
  }

  if (!supported.map((c) => c.toUpperCase()).includes(country.toUpperCase())) {
    return {
      allowed: false,
      country,
      reason:
        `${address} is a ${country} address. Marketing email is only cleared for Australia right now — ` +
        `other countries have their own rules about consent and unsubscribing, and sending before ` +
        `those are set up would put your business on the wrong side of them.`,
    };
  }

  return { allowed: true, country };
}
