// The magic-link landing. Exchanges the code for a session, then sends the operator on.
//
// @machine-callable-ish: the browser arrives here from an email, with no session yet — so the
// middleware matcher must not gate /auth (it doesn't), or the exchange can never happen.

import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type');

  // Only ever a path on this site — the same open-redirect lesson as the old login route.
  const raw = url.searchParams.get('next') || '/queue';
  let next = '/queue';
  try {
    const resolved = new URL(raw, url.origin);
    if (resolved.origin === url.origin) next = resolved.pathname + resolved.search;
  } catch { /* keep /queue */ }

  const store = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (list) => list.forEach(({ name, value, options }) => store.set(name, value, options)),
      },
    },
  );

  // Supabase sends either shape depending on the template; handle both rather than guessing.
  const result = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash
      ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type: (type as 'magiclink') || 'magiclink' })
      : { error: { message: 'No code or token in the link' } as { message: string } };

  if ('error' in result && result.error) {
    return NextResponse.redirect(new URL('/login?e=link', url.origin));
  }
  return NextResponse.redirect(new URL(next, url.origin));
}
