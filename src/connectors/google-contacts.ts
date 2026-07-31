// Resolving "Roger at Quantum Surveys" to an address.
//
// THE PROBLEM THIS EXISTS FOR. The classifier is forbidden from inventing an email address, which is
// correct — a quote landing at a stranger's address is unrecoverable. So it captures the NAME the
// owner said and leaves the address null, and every send with a named-but-unaddressed recipient
// stops and asks. That is safe and it is also the single most common reason a task stalls: an RFQ
// for contour surveys at Lot 109 sat queued for three days with `to: null` because nobody could turn
// "Roger" into an address. The owner knows who Roger is. So does his contact book.
//
// WHY THE "OTHER CONTACTS" LIST MATTERS AS MUCH AS THE REAL ONE. Almost nobody deliberately saves a
// surveyor they use twice a year. Google auto-saves everyone you have emailed into "Other contacts",
// which is exactly where infrequent trade counterparties live — the population this product is for.
// Searching only the curated list would miss most of the people an owner actually asks about.
//
// IT NEVER DECIDES. One match is a SUGGESTION that is read back before anything sends; several
// matches ask which; none asks for the address. The near-miss case — mcdennis@ for mcmdennis@ — is
// unfixable by any lookup or any regex, and the only thing that has ever caught it is a person
// hearing the address said back to them. Finding a candidate changes what we ASK, never whether we
// ask.

import type { SupabaseClient } from '@supabase/supabase-js';

import { accessTokenFor, googleConnectionFor, type GoogleConnection } from './google';

const PEOPLE_API = 'https://people.googleapis.com/v1';

export const CONTACTS_SCOPES = [
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
] as const;

/**
 * What the owner actually granted.
 *
 * Read back, never assumed — the consent screen lets anyone untick a scope, and a connection made
 * before these scopes existed has neither. Asking the API without the scope returns a 403 that is
 * indistinguishable from "no such contact" unless you check first.
 */
export function grantedContactsAccess(scope: string | undefined | null): {
  contacts: boolean;
  otherContacts: boolean;
} {
  const granted = (scope ?? '').split(/\s+/);
  return {
    contacts: granted.includes(CONTACTS_SCOPES[0]),
    otherContacts: granted.includes(CONTACTS_SCOPES[1]),
  };
}

export interface ContactMatch {
  name: string | null;
  email: string;
  /** Which book it came from — 'saved' is a deliberate contact, 'other' is auto-saved from email. */
  source: 'saved' | 'other';
}

interface PeopleResult {
  results?: { person?: { names?: { displayName?: string }[]; emailAddresses?: { value?: string }[] } }[];
}

function matchesFrom(json: PeopleResult, source: ContactMatch['source']): ContactMatch[] {
  const out: ContactMatch[] = [];
  for (const r of json.results ?? []) {
    const name = r.person?.names?.[0]?.displayName ?? null;
    for (const e of r.person?.emailAddresses ?? []) {
      const email = (e.value ?? '').trim();
      if (email) out.push({ name, email, source });
    }
  }
  return out;
}

/**
 * One search against one of the two books.
 *
 * THE WARMUP IS NOT OPTIONAL and is the trap in this API. Google builds the search cache lazily per
 * session: the FIRST query after a connection is made returns an empty result set even when the
 * contact plainly exists, and their own documentation says to send a warmup request with an empty
 * query first. Skipping it produces the worst possible failure — a confident "I couldn't find Roger"
 * about someone who is right there — so an empty first result is retried once after a warmup rather
 * than reported as an answer.
 */
async function searchBook(
  accessToken: string,
  path: 'people:searchContacts' | 'otherContacts:search',
  query: string,
  source: ContactMatch['source'],
): Promise<ContactMatch[]> {
  const call = async (q: string) => {
    const url = new URL(`${PEOPLE_API}/${path}`);
    url.searchParams.set('query', q);
    url.searchParams.set('readMask', 'names,emailAddresses');
    url.searchParams.set('pageSize', '10');
    return fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  };

  let res = await call(query);
  if (!res.ok) {
    // A 403 here means the scope was not granted, which is a fact about the connection rather than
    // about the contact. Surfaced as an error so the caller degrades honestly instead of saying "no
    // such person".
    throw new Error(`People API ${path} failed (${res.status}): ${(await res.text()).slice(0, 160)}`);
  }
  let found = matchesFrom((await res.json()) as PeopleResult, source);
  if (found.length === 0) {
    await call(''); // warm the cache
    res = await call(query);
    if (!res.ok) return [];
    found = matchesFrom((await res.json()) as PeopleResult, source);
  }
  return found;
}

export type RecipientResolution =
  | { status: 'resolved'; match: ContactMatch }
  | { status: 'ambiguous'; matches: ContactMatch[] }
  | { status: 'none' }
  /** We could not look — no connection, no scope, or the API failed. NOT the same as "not found". */
  | { status: 'unavailable'; reason: string };

/** De-duplicate on the address, preferring the saved contact book over the auto-saved one. */
function dedupe(matches: ContactMatch[]): ContactMatch[] {
  const byEmail = new Map<string, ContactMatch>();
  for (const m of matches) {
    const key = m.email.toLowerCase();
    const existing = byEmail.get(key);
    if (!existing || (existing.source === 'other' && m.source === 'saved')) byEmail.set(key, m);
  }
  return [...byEmail.values()];
}

/**
 * Look up a name in the tenant's own contact books.
 *
 * Every failure mode is reported as `unavailable` with a reason rather than as `none`. The
 * distinction is the whole point: "I don't have a Roger" and "I can't see your contacts" lead the
 * owner to do completely different things, and telling him the first when the second is true sends
 * him hunting for an address he has already given us access to.
 */
export async function resolveRecipientByName(
  supabase: SupabaseClient,
  tenantId: string,
  name: string,
  clientId: string,
  clientSecret: string,
): Promise<RecipientResolution> {
  const query = name.trim();
  if (!query) return { status: 'none' };

  const connection = await googleConnectionFor(supabase, tenantId);
  if (!connection) return { status: 'unavailable', reason: 'no Google account is connected' };

  const granted = grantedContactsAccess(connection.scopes);
  if (!granted.contacts && !granted.otherContacts) {
    return {
      status: 'unavailable',
      reason: 'the connected Google account did not grant access to contacts — it needs reconnecting',
    };
  }

  let accessToken: string;
  try {
    accessToken = await accessTokenFor(supabase, connection as GoogleConnection, clientId, clientSecret);
  } catch (error) {
    return { status: 'unavailable', reason: (error as Error).message };
  }

  const books: Promise<ContactMatch[]>[] = [];
  if (granted.contacts) books.push(searchBook(accessToken, 'people:searchContacts', query, 'saved'));
  if (granted.otherContacts) books.push(searchBook(accessToken, 'otherContacts:search', query, 'other'));

  const settled = await Promise.allSettled(books);
  const failures = settled.filter((s) => s.status === 'rejected');
  const matches = dedupe(settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : [])));

  // Both books failing is "we could not look". One failing while the other answers is still a real
  // answer, and worth having — but a NO-MATCH built on a failed search is not, so it degrades.
  if (matches.length === 0 && failures.length > 0) {
    console.error('[google-contacts] search failed:', (failures[0] as PromiseRejectedResult).reason);
    return { status: 'unavailable', reason: 'the contact lookup did not answer' };
  }

  if (matches.length === 0) return { status: 'none' };
  if (matches.length === 1) return { status: 'resolved', match: matches[0] };
  return { status: 'ambiguous', matches: matches.slice(0, 5) };
}
