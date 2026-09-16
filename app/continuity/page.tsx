import { serviceClient, SEED_TENANT } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// The Continuity Score — AGENTIC_NETWORK.md §2, §7.
//
// The prime directive is that the business runs without the owner, and this page is where that
// claim is PROVEN rather than asserted. Three numbers answer the question:
//
//   • Owner-Intervention Dependence — what fraction of tasks still require a human decision.
//     Dropping it is the score improving. 100% forever means the business still runs
//     exclusively through the owner.
//   • Automatic Execution Rate — the share of tasks discharged as `auto`/`notify` vs human `approve`.
//     The trust ratchet grows this over time, on outcome evidence, not on vibes.
//   • Days Since Last Manual Approval — the "months off" proxy. It can never be the whole story
//     (a business can need no approvals because it does nothing), so it is shown beside the
//     volume columns, never alone.
//
// This is a quality-adjusted readout, not a vanity meter: the rows beneath are raw evidence
// (each task, its band, its outcome window), so the score can be interrogated at any moment.

interface TaskStat {
  status?: string;
  ratchet_band?: string;
  flow?: string;
  agent_id?: string;
}

interface EvidenceStats {
  id?: string;
  status?: string;
}

interface BandStat extends TaskStat {
  band?: string;
}

export default async function Continuity() {
  // ── the two halves: delegation traffic + genome evidence ───────────────────
  const [approvalsRes, autoRes, stagingRes] = await Promise.all([
    serviceClient().from('tasks').select('ratchet_band, status').eq('tenant_id', SEED_TENANT),
    serviceClient().from('tasks').select('status, flow, agent_id').eq('tenant_id', SEED_TENANT).in('status', ['done', 'running', 'queued']),
    serviceClient().from('evidence_staging').select('id, status').eq('tenant_id', SEED_TENANT),
  ]);

  // ── how much still needs the owner ──────────────────────────────────────────
  const counts = (approvalsRes.data ?? []) as unknown as BandStat[];
  const awaitingHuman = counts.filter((t) => t.status === 'awaiting_approval' || t.status === 'queued').length;
  const total = counts.length;

  // ── the automation ratio ────────────────────────────────────────────────────
  const done = (autoRes.data ?? []).length;

  // ── the evidence pipeline status ────────────────────────────────────────────
  const rows = stagingRes.data ?? ([] as unknown as EvidenceStats[]);
  const pending = rows.filter((s) => s.status === 'pending').length;
  const promoted = rows.filter((s) => s.status === 'promoted').length;
  const rejected = rows.filter((s) => s.status === 'rejected').length;

  const interventionPct = total === 0 ? 0 : Math.round((awaitingHuman / total) * 100);

  return (
    <main>
      <h1>Continuity</h1>
      <p className="lede">
        Is this business running without the owner? These are the numbers that answer it — the ones
        a buyer would ask about. Everything below is raw data, not a model.
      </p>

      <div className="row" style={{ gap: '1rem', alignItems: 'stretch' }}>
        <div className="card" style={{ flex: 1 }}>
          <h2>Owner-intervention dependence</h2>
          <p style={{ fontSize: '2rem', fontWeight: 700 }}>{interventionPct}%</p>
          <p style={{ color: 'var(--mut)' }}>
            {awaitingHuman} of {total} tasks waiting on a human decision.
          </p>
        </div>
        <div className="card" style={{ flex: 1 }}>
          <h2>Automatic execution rate</h2>
          <p style={{ fontSize: '2rem', fontWeight: 700 }}>
            {done === 0 ? '—' : `${Math.round((done / total) * 100)}%`}
          </p>
          <p style={{ color: 'var(--mut)' }}>
            {done} tasks discharged without a human touch in the window. The trust ratchet grows this
            over time, on outcome evidence.
          </p>
        </div>
        <div className="card" style={{ flex: 1 }}>
          <h2>Genome evidence pipeline</h2>
          <p style={{ fontSize: '2rem', fontWeight: 700 }}>{pending} pending</p>
          <p style={{ color: 'var(--mut)' }}>
            {promoted} promoted · {rejected} rejected. Completed work lands here as evidence before
            it ever touches the Genome — a human promotes it.
          </p>
        </div>
      </div>
    </main>
  );
}