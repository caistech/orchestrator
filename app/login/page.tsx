export const dynamic = 'force-dynamic';

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string; e?: string }> }) {
  const { next = '/queue', e } = await searchParams;
  return (
    <main>
      <h1>Operator access</h1>
      <p className="lede">
        The review queue shows real client names, overdue amounts and drafted messages, so it is not
        public. Enter the operator secret to continue.
      </p>
      {e ? <p style={{ color: 'var(--warn)' }}>That secret was not accepted.</p> : null}
      <form className="inline" method="post" action="/api/login">
        <input type="password" name="secret" placeholder="Operator secret" autoComplete="current-password" required style={{ maxWidth: '22rem' }} />
        <input type="hidden" name="next" value={next} />
        <button className="primary" type="submit">Continue</button>
      </form>
    </main>
  );
}
