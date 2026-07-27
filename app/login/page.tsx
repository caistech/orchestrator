'use client';

// Operator sign-in. Magic link, because it satisfies the auth-page pattern without a password to
// share, rotate or leak — and the previous gate's whole failure was a single shared credential.
//
// §2 note: a password field would need a visibility toggle and a forgot-password flow. Passwordless
// removes both surfaces rather than half-implementing them; "forgot password" IS the flow here.

import { useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';

export default function Login() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/api/auth/callback` },
    });
    // Say "sent" either way. Telling a stranger which addresses are operators turns this form into a
    // membership oracle, and an operator who mistypes gets the same nudge as one who is not on the list.
    if (error && !/rate/i.test(error.message)) setError(null);
    if (error && /rate/i.test(error.message)) setError('Too many attempts just now — wait a minute and try again.');
    setSent(true); setBusy(false);
  }

  return (
    <main>
      <h1>Operator sign-in</h1>
      <p className="lede">
        The orchestrator is internal. It shows real client names, amounts owing and drafted messages,
        so access is limited to named operators. Enter your work email and we will send you a sign-in link.
      </p>

      {sent ? (
        <div className="card">
          <strong>Check your email.</strong>
          <p style={{ color: 'var(--mut)', marginTop: '.5rem' }}>
            If <em>{email}</em> belongs to an operator, a sign-in link is on its way. The link works once
            and expires shortly. You can close this tab — open the link on this device.
          </p>
        </div>
      ) : (
        <form onSubmit={send} className="inline" style={{ maxWidth: '26rem' }}>
          <input
            type="email" name="email" required autoComplete="email" placeholder="you@yourcompany.com"
            value={email} onChange={(e) => setEmail(e.target.value)}
          />
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Email me a sign-in link'}
          </button>
        </form>
      )}
      {error && <p style={{ color: 'var(--warn)' }}>{error}</p>}
    </main>
  );
}
