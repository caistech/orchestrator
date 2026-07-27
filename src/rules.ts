// The threshold rules — the twenty §6 flows, as DATA.
//
// TASK_REGISTRY §6 is explicit that these twenty share ONE mechanism:
//
//   sweep canonical rows → find those past a threshold → compose a message from a template plus
//   context → apply gate → send
//
// So the mechanism is code (sweeper.ts) and the flows are rows in this array. Adding the 21st flow
// must not mean writing a 21st function, or the registry-sprawl risk in spec §11 lands: twenty
// near-identical code paths that drift apart and each acquire their own bugs.
//
// The predicate language below is deliberately small. It covers exactly the shapes the registry's
// twenty actually need — an integer threshold, an age, an upcoming date, and a JSON numeric
// comparison — and no more. A general expression language here would be a small database engine
// nobody asked for, and it would move the logic out of reach of a reader.

/** What a rule compares against. Small on purpose — see the note above. */
export type Threshold =
  /** An integer column at or past a value. `days_overdue >= 30` */
  | { kind: 'atLeast'; column: 'days_overdue'; value: number }
  /** An integer column below a value — the UPPER bound that stops 45 stealing 46's rows. */
  | { kind: 'below'; column: 'days_overdue'; value: number }
  /** A timestamp older than an interval. `last_contacted_at < now() - '14 days'` */
  | { kind: 'olderThan'; column: 'last_contacted_at'; interval: string }
  /** A date falling within an interval from now. `expires_on <= now() + '30 days'` */
  | { kind: 'within'; column: 'expires_on'; interval: string }
  /** One attributes-JSON number below another. `on_hand < minimum` — no column exists for this. */
  | { kind: 'jsonBelow'; a: string; b: string };

export interface SweepRule {
  /** The registry flow id, so a task traces back to the row that justified building it. */
  flow: string;
  name: string;
  /** Which entity kind this rule reads. */
  entityKind: string;
  thresholds: Threshold[];

  /**
   * The action this produces. The GATE resolves from this — not from the flow — because a $60
   * reorder and a $60k order are the same flow and must gate differently (TASK_REGISTRY §7).
   */
  action: string;

  /** Where the money figure lives, when the action has one. Read from attributes. */
  spendAttribute?: string;

  /**
   * Whether the source of record must be re-checked before anything is emitted.
   *
   * TRUE for anything read from a projected system, because a projection is stale the moment it is
   * written and the failure is concrete: chasing an invoice the client paid this morning. The sweep
   * finds CANDIDATES; the source makes the DECISION (ORCHESTRATOR_SPEC §9).
   *
   * FALSE only where we are already canonical — an insurance certificate expiry we hold ourselves
   * has no elsewhere to confirm against.
   */
  confirmAtSource: boolean;

  /**
   * Is this a COMMERCIAL electronic message under the Spam Act 2003?
   *
   * This is a legal classification, not a tone one, and getting it wrong in either direction is
   * expensive. Commercial mail (promoting goods or services — reawakening a quiet client, chasing a
   * cold lead) requires consent, identification AND a working unsubscribe. Transactional mail about
   * an existing dealing (their own overdue invoice, a quote they asked for, a certificate expiring
   * under a contract they signed) is not commercial and may omit the unsubscribe — but still carries
   * the identification footer.
   *
   * Marking everything commercial is not the "safe" option: it puts an unsubscribe link on a debt
   * notice, which invites a customer to opt out of being told they owe money.
   */
  commercial: boolean;

  /** One line the human sees in the review queue. Kept here so the flow owns its own words. */
  template: (e: SweepEntity) => { summary: string; body: string };
}

export interface SweepEntity {
  id: string;
  tenant_id: string;
  kind: string;
  mode: 'projected' | 'authoritative';
  source_system: string | null;
  source_id: string | null;
  display_name: string;
  email: string | null;
  account_type: string | null;
  days_overdue: number | null;
  last_contacted_at: string | null;
  expires_on: string | null;
  attributes: Record<string, unknown>;
}

const money = (e: SweepEntity, key: string): number | null => {
  const v = e.attributes?.[key];
  return typeof v === 'number' ? v : null;
};

const aud = (n: number | null) =>
  n === null ? '' : n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });

/**
 * The rules. Seven here rather than twenty because these are the ones the dev seed can actually
 * exercise end to end; the remaining thirteen are the same shape and land as the connectors that
 * feed their entity kinds do. Listing rules we cannot yet run would be a roadmap pretending to be
 * a capability.
 */
export const RULES: SweepRule[] = [
  {
    flow: '45',
    name: 'chase a 30-day overdue account',
    entityKind: 'invoice',
    // The upper bound matters: without it every 67-day invoice fires BOTH this and 46, and the
    // client gets a polite reminder and a final notice in the same run.
    thresholds: [
      { kind: 'atLeast', column: 'days_overdue', value: 30 },
      { kind: 'below', column: 'days_overdue', value: 60 },
    ],
    action: 'debt.chase',
    commercial: false,
    spendAttribute: 'amount',
    confirmAtSource: true,
    template: (e) => ({
      summary: `Chase ${e.display_name} — ${e.days_overdue} days overdue`,
      body:
        `Just a reminder that ${e.display_name} (${aud(money(e, 'amount'))}) is now ` +
        `${e.days_overdue} days past due. Could you let us know when we can expect payment?`,
    }),
  },
  {
    flow: '46',
    name: 'escalate a 60 or 90-day debt',
    entityKind: 'invoice',
    thresholds: [{ kind: 'atLeast', column: 'days_overdue', value: 60 }],
    action: 'debt.escalate',
    commercial: false,
    spendAttribute: 'amount',
    confirmAtSource: true,
    template: (e) => ({
      summary: `ESCALATE ${e.display_name} — ${e.days_overdue} days overdue`,
      body:
        `${e.display_name} (${aud(money(e, 'amount'))}) is ${e.days_overdue} days overdue and has ` +
        `passed our normal terms. We need to agree a payment date this week.`,
    }),
  },
  {
    flow: '9',
    name: 'chase a lead that went quiet',
    entityKind: 'contact',
    thresholds: [{ kind: 'olderThan', column: 'last_contacted_at', interval: '14 days' }],
    action: 'lead.chase',
    commercial: true,
    confirmAtSource: true,
    template: (e) => ({
      summary: `Follow up ${e.display_name} — quiet since last contact`,
      body: `Following up on our earlier conversation — are you still looking at this? Happy to answer anything outstanding.`,
    }),
  },
  {
    flow: '19',
    name: 'quote follow-up at day 3, 7, 14',
    entityKind: 'quote',
    thresholds: [{ kind: 'olderThan', column: 'last_contacted_at', interval: '7 days' }],
    action: 'quote.followup',
    commercial: false,
    spendAttribute: 'amount',
    confirmAtSource: true,
    template: (e) => ({
      summary: `Follow up ${e.display_name} (${aud(money(e, 'amount'))})`,
      body: `Checking in on the quote we sent for ${e.display_name}. Any questions, or would you like to proceed?`,
    }),
  },
  {
    flow: '127',
    name: 'subcontractor insurance / certification expiry',
    entityKind: 'subcontractor',
    thresholds: [{ kind: 'within', column: 'expires_on', interval: '30 days' }],
    action: 'compliance.expiry',
    commercial: false,
    // We hold this ourselves — there is no source system to confirm against.
    confirmAtSource: false,
    template: (e) => ({
      summary: `${e.display_name} — ${String(e.attributes?.document ?? 'document')} expires ${e.expires_on}`,
      body:
        `Your ${String(e.attributes?.document ?? 'certificate')} expires on ${e.expires_on}. ` +
        `Please send through the renewal so we can keep you on site.`,
    }),
  },
  {
    flow: '56',
    name: 'reorder stock hitting minimum levels',
    entityKind: 'sku',
    thresholds: [{ kind: 'jsonBelow', a: 'on_hand', b: 'minimum' }],
    action: 'stock.reorder',
    commercial: false,
    spendAttribute: 'reorder_value',
    confirmAtSource: true,
    template: (e) => ({
      summary: `Reorder ${e.display_name} — ${e.attributes?.on_hand} on hand, minimum ${e.attributes?.minimum}`,
      body: `Please supply ${e.display_name}. Current stock is below our minimum.`,
    }),
  },
  {
    flow: '67',
    name: 'reach out to a client quiet for six months',
    entityKind: 'account',
    thresholds: [{ kind: 'olderThan', column: 'last_contacted_at', interval: '6 months' }],
    action: 'client.reawaken',
    commercial: true,
    confirmAtSource: true,
    template: (e) => ({
      summary: `Reawaken ${e.display_name} — no activity in 6 months`,
      body: `It has been a while since we worked together. Is there anything coming up we could help with?`,
    }),
  },
];
