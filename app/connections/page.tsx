import { serviceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// Which of a business's own systems we can currently read. This exists because a connection that has
// quietly expired looks identical, from the queue, to a business with nothing overdue.
export default async function Connections() {
  const { data } = await serviceClient()
    .from('connections')
    .select('provider, provider_org_name, connected_at, last_synced_at, revoked_at, last_error, tenants(name)')
    .order('connected_at', { ascending: false });

  const rows = (data ?? []) as unknown as Array<{
    provider: string; provider_org_name: string | null; connected_at: string;
    last_synced_at: string | null; revoked_at: string | null; last_error: string | null;
    tenants: { name: string } | null;
  }>;

  return (
    <main>
      <h1>Connections</h1>
      <p className="lede">
        The systems we are authorised to read on a client&apos;s behalf. Access is read-only, and it is
        checked again before anything is sent — a stale copy is never acted on by itself.
      </p>
      {rows.length === 0 ? (
        <div className="empty">
          No systems connected yet.
          <div style={{ marginTop: '1rem' }}><a href="/api/connect/xero">Connect Xero →</a></div>
        </div>
      ) : rows.map((c, i) => (
        <article className="card" key={i}>
          <div className="row">
            <strong>{c.tenants?.name ?? 'Unknown client'} · {c.provider}</strong>
            <span className="tag">{c.revoked_at ? 'revoked' : 'active'}</span>
          </div>
          <div className="tag" style={{ marginTop: '.35rem' }}>
            {c.provider_org_name} — last synced {c.last_synced_at ? new Date(c.last_synced_at).toLocaleString('en-AU') : 'never'}
          </div>
          {c.last_error && <div className="body" style={{ color: 'var(--warn)' }}>{c.last_error}</div>}
        </article>
      ))}
    </main>
  );
}
