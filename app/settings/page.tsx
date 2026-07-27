import { currentAdmin, adminEmails } from '@/lib/supabase-auth';

export const dynamic = 'force-dynamic';

// §4 Settings. Lean by design and stated as such: this is a single-purpose internal tool, so the
// Profile / Notifications sections a customer product needs would be furniture with nothing behind
// them. What IS here is what an operator actually needs — who am I, who else can get in, and how do
// I leave. The deferral is the documented single-operator one, not an omission.
export default async function Settings() {
  const operator = await currentAdmin();
  const others = adminEmails().filter((e) => e !== operator?.email.toLowerCase());

  return (
    <main>
      <h1>Settings</h1>
      <p className="lede">
        Your access to the orchestrator, and who else has it. Access is controlled by an allowlist of
        named operators — there is no self-service signup, because this tool can send email on a
        business&apos;s behalf.
      </p>

      <h2>Your account</h2>
      <div className="card">
        <div className="row"><strong>{operator?.email}</strong><span className="tag">operator</span></div>
        <p style={{ color: 'var(--mut)', marginTop: '.5rem' }}>
          You sign in with a one-time link rather than a password, so there is no password to change,
          share or lose. Signing out ends this session everywhere it is open on this device.
        </p>
        <form action="/api/auth/signout" method="post" style={{ marginTop: '.75rem' }}>
          <button type="submit">Sign out</button>
        </form>
      </div>

      <h2>Who else has access</h2>
      <div className="card">
        {others.length === 0 ? (
          <p style={{ color: 'var(--mut)' }}>Nobody else. You are the only operator on the allowlist.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {others.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
        <p style={{ color: 'var(--mut)', marginTop: '.75rem' }}>
          The list lives in configuration (<code>ADMIN_EMAILS</code>), not in this screen. Adding or
          removing someone is a deliberate deployment change rather than a click — which is the point,
          for a tool that can email a business&apos;s customers.
        </p>
      </div>
    </main>
  );
}
