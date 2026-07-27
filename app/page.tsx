export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <main>
      {/* Explanatory header — what this is, what to do, why it matters (PRODUCT_STANDARDS §5). */}
      <h1>Orchestrator</h1>
      <p className="lede">
        Decides what should happen across the business and who must approve it. A sweep looks for
        things past a threshold — an invoice aged, a certificate expiring, a quote gone quiet — checks
        the source of record before acting, drafts the message, and applies the delegation policy.
        Routine work proceeds; anything that commits you waits here for a decision.
      </p>
      <p><a href="/queue">Open the review queue →</a></p>
    </main>
  );
}
