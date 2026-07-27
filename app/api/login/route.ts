// Exchange the operator secret for a session cookie. HttpOnly + Secure + SameSite=Lax so it cannot
// be read from page JS and does not ride along on cross-site requests.
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Constrain `next` to a path on THIS site.
 *
 * Without this it was an open redirect: `next=https://evil.example.com/pwn` and the protocol-
 * relative `next=//evil.example.com` both produced a Location header pointing at the attacker.
 * It fired only on a CORRECT secret, which makes it sound minor and is precisely what makes it
 * useful — the victim sees our real login, authenticates successfully, and lands somewhere else
 * with the visit laundered through a domain they trust.
 *
 * `new URL(next, request.url)` does not help: that is what resolves an absolute or protocol-
 * relative value straight back to the foreign origin.
 *
 * Rule: exactly one leading slash, and no backslash (browsers normalise `/\evil.com` to `//evil.com`).
 * Anything else falls back to /queue rather than being repaired — a `next` we do not recognise is
 * one we should not follow.
 */
function safeNext(raw: FormDataEntryValue | null, base: string): string {
  const value = String(raw ?? '').trim();
  if (!value.startsWith('/')) return '/queue';                            // absolute, scheme-relative
  if (value.startsWith('//') || value.startsWith('/\\')) return '/queue'; // protocol-relative

  // Then RESOLVE and compare origins, rather than trusting the prefix checks above.
  //
  // String prefixes are a guess about how the runtime will parse the value, and that guess was
  // already wrong once: `//evil.example.com` arrived here as a single-slash path, so the
  // protocol-relative branch never fired and the redirect landed on /evil.example.com. Harmless on
  // our own origin, but it proves the check was reasoning about a string the runtime had already
  // rewritten. Resolving against the real base and comparing origin is decidable rather than
  // predictive: whatever normalisation happens, the answer is "does this end up on our host".
  try {
    const resolved = new URL(value, base);
    return resolved.origin === new URL(base).origin ? resolved.pathname + resolved.search : '/queue';
  } catch {
    return '/queue';
  }
}

export async function POST(request: Request) {
  const expected = process.env.ORCHESTRATOR_SECRET;
  if (!expected) return NextResponse.json({ error: 'not configured' }, { status: 503 });

  const form = await request.formData();
  const supplied = String(form.get('secret') ?? '');
  const next = safeNext(form.get('next'), request.url);

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
