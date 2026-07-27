// Exchange the operator secret for a session cookie. HttpOnly + Secure + SameSite=Lax so it cannot
// be read from page JS and does not ride along on cross-site requests.
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const expected = process.env.ORCHESTRATOR_SECRET;
  if (!expected) return NextResponse.json({ error: 'not configured' }, { status: 503 });

  const form = await request.formData();
  const supplied = String(form.get('secret') ?? '');
  const next = String(form.get('next') ?? '/queue');

  // Constant-ish comparison: length check first, then a full scan that does not early-exit.
  let ok = supplied.length === expected.length;
  for (let i = 0; i < expected.length; i++) ok = (supplied[i] === expected[i]) && ok;
  if (!ok) {
    return NextResponse.redirect(new URL(`/login?e=1&next=${encodeURIComponent(next)}`, request.url), 303);
  }

  const res = NextResponse.redirect(new URL(next, request.url), 303);
  res.cookies.set('orch_operator', expected, {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 12,
  });
  return res;
}
