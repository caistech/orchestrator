// The gate.
//
// POLICY (operator directive, 2026-07-28): the orchestrator is INFRASTRUCTURE. No public viewer
// should ever see one of its pages. Everything is gated — including the root — with exactly one
// exception.
//
//   /unsubscribe  MUST stay public. It is printed in emails to real customers and is a legal
//                 obligation under the Spam Act; putting it behind a login would mean an opt-out
//                 only staff could action, which is worse than not offering one.
//
// Machine routes (/api/*) are excluded from the matcher and authenticate themselves — each refuses
// fail-closed on its own secret. That exclusion is load-bearing, not tidiness: a session redirect on
// a machine route is a 307 the caller follows to an HTML page, so nothing throws, nothing logs, and
// the feature silently never runs. ExecutorAI lost the same feature to exactly that, twice in a day.
//
// This replaces a shared-secret cookie whose value WAS the secret: one credential shared by every
// operator, never rotating, revocable only by changing it for everybody — and carrying no identity,
// so an approval queue that sends real customer email could not say who approved anything.

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // Unconfigured means the gate cannot be enforced. Refuse rather than expose the queue — an auth
  // check that quietly evaporates when a variable is missing is how routes end up open.
  if (!url || !key) {
    return new NextResponse('Access control is not configured.', { status: 503 });
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // getUser(), never getSession(): getSession reads the cookie without validating it, so a forged or
  // stale one would pass. This asks the auth server.
  const { data: { user } } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const onLogin = path === '/login';

  if (!user) {
    if (onLogin) return response;
    const to = request.nextUrl.clone();
    to.pathname = '/login';
    to.searchParams.set('next', path);
    return NextResponse.redirect(to);
  }

  // Signed in but not an operator. Send them somewhere that SAYS so — bouncing an authenticated
  // person back to a login form is the loop where people conclude the product is broken rather than
  // that they lack access.
  const allow = (process.env.ADMIN_EMAILS || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const isAdmin = !!user.email && allow.includes(user.email.toLowerCase());

  if (!isAdmin && !onLogin) {
    const to = request.nextUrl.clone();
    to.pathname = '/no-access';
    to.search = '';
    return NextResponse.redirect(to);
  }

  if (onLogin && isAdmin) {
    const to = request.nextUrl.clone();
    to.pathname = '/queue';
    to.search = '';
    return NextResponse.redirect(to);
  }

  return response;
}

export const config = {
  matcher: [
    // Everything EXCEPT: /api (machine routes, self-authenticating), /unsubscribe (must stay public),
    // /no-access (or a non-operator loops forever), Next internals and static assets.
    '/((?!api/|unsubscribe|no-access|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt)$).*)',
  ],
};
