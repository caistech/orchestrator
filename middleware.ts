// The operator gate.
//
// The review queue shows a real business's overdue invoices, client names and drafted messages, so
// it cannot be public. It is gated by a signed cookie issued at /login against ORCHESTRATOR_SECRET.
//
// THIS IS AN INTERIM, SINGLE-OPERATOR GATE, and saying so is the point. The portfolio canon is
// @caistech/corporate-components AuthForm over Supabase auth, and the single-operator deferral in
// PRODUCT_STANDARDS §9 permits deferring the org/member layer — but NOT permanently, and not past
// the moment a second person needs access. When that happens this is replaced, not extended.
//
// The matcher deliberately excludes /unsubscribe and /api. A session redirect on a machine route is
// a 307 the caller follows to an HTML page: nothing throws, nothing logs, and the feature simply
// never runs. That exact failure cost ExecutorAI its voice memory twice in one day, so the
// exclusions here are load-bearing, not tidiness.

import { NextResponse, type NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const expected = process.env.ORCHESTRATOR_SECRET;
  // No secret means the gate cannot be enforced. Refuse rather than expose the queue.
  if (!expected) {
    return new NextResponse('Operator access is not configured.', { status: 503 });
  }
  const cookie = request.cookies.get('orch_operator')?.value;
  if (cookie === expected) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', request.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/queue/:path*'],
};
