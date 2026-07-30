// Turning something a person said into something they can approve.
//
// This is the half the orchestrator was missing. `/v1/dispatch` accepted a SAY intent, wrote a
// `queued` row and answered "Accepted." — so an owner who said "chase Dave about the Wavecrest
// quote" got an acknowledgement and then nothing, forever, because no part of the orchestrator
// processes a spoken task. Kira's local stub had always done this; connecting the two systems
// without porting it would have made the product WORSE while looking more connected.
//
// Ported deliberately rather than reinvented: same three owned kinds, same hold-for-approval shape,
// same refusal to invent a recipient. The behaviour an owner already experiences must not change
// just because the work moved house.
//
// HUMAN-IN-THE-LOOP IS STRUCTURAL. This function NEVER sends. It drafts and returns
// awaiting_approval; only the approve route emits an effect. A wrong quote that goes out is worse
// than a slow one.

export type OwnedKind = 'quote' | 'email' | 'reminder';
export const OWNED_KINDS: OwnedKind[] = ['quote', 'email', 'reminder'];

export interface Classified {
  kind: OwnedKind | 'unsupported';
  recipient_name: string | null;
  recipient_email: string | null;
  subject: string | null;
  due_hint: string | null;
  reason_if_unsupported: string | null;
}

export interface Drafted {
  summary: string;
  preview: string;
}

const CLASSIFY_SYSTEM = `
You triage an owner-operator's spoken request into ONE task their assistant can do:
- "quote": prepare a price quote for a client.
- "email": draft a message to a named person (a follow-up, a reply, an intro).
- "reminder": set a reminder / follow-up for the owner themselves.
- "unsupported": anything else (booking, invoicing to an external system, ordering materials, etc.).
Extract any recipient, subject and timing the owner stated. Use null for anything not stated; never invent an email address.
Reply with ONLY a JSON object: {"kind":..., "recipient_name":..., "recipient_email":..., "subject":..., "due_hint":..., "reason_if_unsupported":...}
`.trim();

/**
 * The drafting instruction per kind.
 *
 * `preview` is what gets sent VERBATIM on approval, so a placeholder left in the sign-off is not
 * filled in by anything downstream — it reaches the client as typed. Kira mailed "Thanks, [Owner's
 * Name]" to a real address exactly once before this was understood.
 */
function draftSystem(kind: OwnedKind, ownerName: string | null): string {
  const signoff = ownerName
    ? `The owner you are drafting as is ${ownerName} — sign off as them. `
    : "You do not know the owner's name: end after the final sentence with no sign-off name. ";
  const common =
    'You draft on behalf of a hands-on business owner. Match a busy, plain, professional ' +
    'tradesperson/operator voice — warm, direct, no corporate fluff, no emoji. ' +
    signoff +
    "NEVER write a placeholder for the sender (no [Owner's Name], [Your Name], [Company]) — the " +
    'preview is sent exactly as written. ' +
    'Reply with ONLY a JSON object: {"summary": one line the owner hears, "preview": the full draft}.';

  if (kind === 'quote')
    return `${common} Draft a short client-ready quote message. If amounts or scope are missing, draft the covering message and leave clearly-marked [line item] / [$amount] placeholders for the owner to fill.`;
  if (kind === 'email')
    return `${common} Draft the email body only (no subject line inside the body). Keep it a few sentences.`;
  return `${common} Draft a one-line reminder the owner will get back later, plus when it should fire.`;
}

async function askModel(apiKey: string, system: string, user: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      console.error(`[drafter] model → ${res.status}`);
      return null;
    }
    const json = await res.json();
    return JSON.parse(json?.choices?.[0]?.message?.content ?? '{}');
  } catch (e) {
    console.error('[drafter] failed:', e);
    return null;
  }
}

/** Shaped like an email address at all. Deliberately loose — the strict authority is the recipient. */
const PLAUSIBLE_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * An address the owner SPELLED OUT, transcribed letter by letter and taken literally.
 *
 * Three or more single-character-then-separator groups at the start of the local part. A real
 * hyphenated address ("jo-anne@", "mary-kate@") never matches, because those groups are words.
 * This is not hypothetical: `m-c-m-d-e-n-n-i-s@gmail.com` reached the outbox and would have bounced.
 */
const SPELLED_ALOUD = /^([a-z0-9][-.\s]){3,}/i;

/**
 * What survives as a usable recipient.
 *
 * REFUSES rather than repairs. Stripping the separators out of a spelled-aloud address reconstructs
 * this one correctly and is still the wrong move: it is a guess about what someone said out loud,
 * and the cost of being wrong is a quote landing at a stranger's address. Returning null routes into
 * the path that already exists for a missing recipient — Kira asks him for it — and asking is cheap.
 *
 * The near miss is the case no check catches: `mcdennis@gmail.com` for `mcmdennis@gmail.com` is one
 * character short, perfectly well-formed, and only the owner can spot it. That is why every send is
 * marked for a read-back rather than trusted to a regex.
 */
function usableRecipient(value: unknown): string | null {
  const email = typeof value === 'string' ? value.trim() : '';
  if (!email) return null;

  if (SPELLED_ALOUD.test(email.split('@')[0] ?? '')) {
    console.warn(`[drafter] refusing a spelled-aloud address (${email}) — asking the owner instead.`);
    return null;
  }
  if (!PLAUSIBLE_EMAIL.test(email)) {
    console.warn(`[drafter] refusing an unusable address (${email}) — asking the owner instead.`);
    return null;
  }
  return email;
}

export async function classifyIntent(apiKey: string, utterance: string): Promise<Classified | null> {
  const raw = await askModel(apiKey, CLASSIFY_SYSTEM, utterance);
  if (!raw) return null;
  const kind = String(raw.kind ?? 'unsupported');
  return {
    kind: (OWNED_KINDS as string[]).includes(kind) ? (kind as OwnedKind) : 'unsupported',
    recipient_name: (raw.recipient_name as string) ?? null,
    recipient_email: usableRecipient(raw.recipient_email),
    subject: (raw.subject as string) ?? null,
    due_hint: (raw.due_hint as string) ?? null,
    reason_if_unsupported: (raw.reason_if_unsupported as string) ?? null,
  };
}

export async function draftForIntent(
  apiKey: string,
  kind: OwnedKind,
  utterance: string,
  cls: Classified,
  ownerName: string | null,
  context?: Record<string, unknown>,
): Promise<Drafted | null> {
  const input =
    `Owner said: "${utterance}"\n` +
    (ownerName ? `You are drafting as: ${ownerName}\n` : '') +
    (cls.recipient_name ? `Recipient: ${cls.recipient_name}\n` : '') +
    (cls.subject ? `Subject: ${cls.subject}\n` : '') +
    (cls.due_hint ? `When: ${cls.due_hint}\n` : '') +
    (context ? `Context you already hold: ${JSON.stringify(context).slice(0, 1500)}\n` : '');

  const raw = await askModel(apiKey, draftSystem(kind, ownerName), input);
  if (!raw?.summary || !raw?.preview) return null;
  return { summary: String(raw.summary), preview: String(raw.preview) };
}
