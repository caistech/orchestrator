// The review queue — the surface the delegation policy hands work to.
//
// This is the other half of gating. A gate that holds work with nowhere to review it is not a
// safeguard, it is a stall; and a queue nobody reads is WORSE than no queue, because it launders
// unreviewed output as approved. So this shows the whole drafted message, not a summary — the
// decision being asked for is "may this exact text go to this exact person", and it cannot be made
// from a one-line title.
//
// The band and the reason it was held are shown on every card, because the useful reaction to a
// noisy queue is not to click faster, it is to change the policy — and that needs the operator to
// see WHY something is here.

import { serviceClient, SEED_TENANT } from '@/lib/supabase';
import { decide } from './actions';
import { ConfirmSend } from './ConfirmSend';

export const dynamic = 'force-dynamic';

interface Row {
  id: string;
  summary: string | null;
  flow: string | null;
  payload: { band?: string; why?: string; action?: string; spend?: number | null } | null;
  drafts: { subject: string | null; body: string; recipients: string[] }[];
}

export default async function Queue() {
  const supabase = serviceClient();
  const { data } = await supabase
    .from('tasks')
    .select('id, summary, flow, payload, drafts(subject, body, recipients)')
    .eq('tenant_id', SEED_TENANT)
    .eq('status', 'awaiting_approval')
    .order('created_at', { ascending: true });

  const rows = (data ?? []) as unknown as Row[];

  return (
    <main>
      <h1>Review queue</h1>
      <p className="lede">
        Work the delegation policy would not release on its own. Each item shows the message exactly
        as it would be sent and why it was held. Approving puts it in the outbox — it is sent by the
        next drain, and recorded before it is attempted.
      </p>

      {rows.length === 0 ? (
        <div className="empty">
          Nothing is waiting. Routine work has proceeded on its own — that is the policy doing its job,
          not an empty system.
        </div>
      ) : (
        rows.map((t) => {
          const d = t.drafts?.[0];
          return (
            <article className="card" key={t.id}>
              <div className="row">
                <strong>{t.summary ?? '(no summary)'}</strong>
                <span className="tag">
                  flow {t.flow} · {t.payload?.band ?? 'held'}
                </span>
              </div>
              <div className="tag" style={{ marginTop: '.35rem' }}>
                to {d?.recipients?.[0] ?? '(no recipient)'} — held because {t.payload?.why ?? 'policy'}
              </div>
              <div className="body">{d?.body ?? '(no draft)'}</div>
              {/* Consequence before the click (§9). An approved send leaves the building and cannot
                  be recalled, so the confirm names the RECIPIENT — the detail that actually catches a
                  mistake. "Are you sure?" catches nothing; "send this to karen@… ?" catches the row
                  you did not mean to be on. */}
              <ConfirmSend
                taskId={t.id}
                recipient={d?.recipients?.[0] ?? null}
                summary={t.summary ?? 'this message'}
                action={decide}
              />
            </article>
          );
        })
      )}
    </main>
  );
}
