import { serviceClient, SEED_TENANT } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// Everything the sweep has raised, decided or sent. The review queue answers "what needs me now";
// this answers "what has this thing been doing", which is the question you ask before you trust it.
export default async function Tasks() {
  const { data } = await serviceClient()
    .from('tasks')
    .select('id, flow, status, summary, created_at')
    .eq('tenant_id', SEED_TENANT)
    .order('created_at', { ascending: false })
    .limit(50);

  const rows = data ?? [];
  return (
    <main>
      <h1>All work</h1>
      <p className="lede">
        Every task the sweep has raised, most recent first. Nothing here needs your attention —
        anything waiting on a decision is in the review queue.
      </p>
      {rows.length === 0 ? (
        <div className="empty">Nothing yet. The sweep runs hourly and will fill this in.</div>
      ) : rows.map((t) => (
        <article className="card" key={t.id}>
          <div className="row">
            <span>{t.summary ?? '(no summary)'}</span>
            <span className="tag">flow {t.flow} · {t.status}</span>
          </div>
        </article>
      ))}
    </main>
  );
}
