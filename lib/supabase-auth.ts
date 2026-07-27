// Session-scoped Supabase clients — the real auth, replacing the shared-secret cookie.
//
// WHY THIS REPLACED THE SECRET GATE. The interim gate stored the operator secret itself as the
// cookie value: every operator held the identical credential, it never rotated, and there was no way
// to revoke one person without changing the secret for everyone. Worse for an approval tool — the
// review queue authorises real emails to real customers, and "who approved this send?" had no
// possible answer, because there was no person in the session at all. That is not a tidiness gap;
// an audit trail that cannot name anyone is not an audit trail.
//
// Now: Supabase Auth for identity, an ADMIN_EMAILS allowlist for authorisation, per-PERSON sessions
// that expire and can be revoked individually, and a real Sign Out.

import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/** The operators allowed in. Empty means NOBODY — an unset allowlist locks the door, never opens it. */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  return adminEmails().includes(email.toLowerCase());
}

/** A Supabase client bound to the request's cookies, for reading/refreshing the session. */
export async function sessionClient() {
  const store = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (list) => {
          try {
            list.forEach(({ name, value, options }) => store.set(name, value, options));
          } catch {
            // Called from a Server Component, where cookies are read-only. The middleware refreshes
            // the session, so swallowing here is correct rather than a silent failure.
          }
        },
      },
    },
  );
}

/** The signed-in operator, or null. Identity only — authorisation is the allowlist below. */
export async function currentOperator(): Promise<{ id: string; email: string } | null> {
  const supabase = await sessionClient();
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user?.email) return null;
  return { id: user.id, email: user.email };
}

/**
 * Signed in AND on the allowlist. Both, deliberately: a Supabase project with open signup would
 * otherwise let anyone who can create an account reach a queue of another business's invoices.
 * Authentication is not authorisation.
 */
export async function currentAdmin(): Promise<{ id: string; email: string } | null> {
  const operator = await currentOperator();
  return operator && isAdminEmail(operator.email) ? operator : null;
}
