// The unsubscribe endpoint.
//
// This is the route that unblocks commercial mail. Until it existed, the email connector REFUSED
// every commercial send rather than shipping one without a working opt-out — which is the correct
// order to build these in: the obligation before the capability.
//
// Entirely delegated to @caistech/email-compliance, which already resolves the three things that
// are easy to get wrong:
//
//   1. A bare GET must NOT unsubscribe. Mail clients and security scanners pre-fetch links, so a
//      mutating GET gets triggered by a scanner nobody asked, and the recipient is opted out of
//      mail they wanted. The handler shows a confirm button and supports RFC 8058 one-click POST,
//      which exists for exactly this reason.
//   2. An invalid token returns a NEUTRAL 200, never an error. "That address isn't on our list"
//      turns the endpoint into an address oracle, and someone trying to leave should not be shown
//      a failure either way.
//   3. The page carries the sender's legal identity, so a recipient checking who is actually
//      emailing them doesn't have to go back to the email to find out.
//
// Public by design — it is linked from mail, so it cannot sit behind the operator gate. Excluded
// from the middleware matcher for that reason.

import { createUnsubscribeRoute, createSupabaseSuppressionStore, type SupabaseLike } from '@caistech/email-compliance';
import { serviceClient } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const secret = process.env.UNSUBSCRIBE_SECRET ?? '';

// Fail closed. Without the HMAC secret no token can be verified, so every request would either be
// rejected or — far worse — waved through. A 503 says "this is misconfigured", which is true.
const handlers = secret
  ? createUnsubscribeRoute({
      secret,
      // Cast through unknown: supabase-js's generated types are deep enough that inferring them
      // through the package's structural SupabaseLike blows TypeScript's instantiation limit. The
      // store only ever calls select/upsert/delete on one table, which this satisfies.
      store: createSupabaseSuppressionStore({ supabase: serviceClient() as unknown as SupabaseLike }),
      brandName: 'Orchestrator',
    })
  : null;

export async function GET(request: Request): Promise<Response> {
  if (!handlers) return misconfigured();
  return handlers.GET(request);
}

export async function POST(request: Request): Promise<Response> {
  if (!handlers) return misconfigured();
  return handlers.POST(request);
}

function misconfigured(): Response {
  console.error('[unsubscribe] UNSUBSCRIBE_SECRET is not set — cannot verify opt-out tokens.');
  return new Response('Unsubscribe is temporarily unavailable. Please reply to the email instead.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain' },
  });
}
