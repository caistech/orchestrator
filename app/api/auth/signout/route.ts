// Sign out — a real one. Ends THIS person's session server-side; it does not merely drop a cookie.
//
// The gate it replaces had no sign-out at all, because there was no session to end: the cookie was
// the shared secret, so "signing out" would have meant nothing while the credential stayed valid
// for everyone.

import { NextResponse } from 'next/server';
import { sessionClient } from '@/lib/supabase-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const supabase = await sessionClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL('/login', request.url), 303);
}
