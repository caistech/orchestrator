export const dynamic = 'force-dynamic';

// A signed-in person who is not an operator lands here rather than being bounced back to the login
// form. The bounce loop is how someone concludes the product is broken instead of that they simply
// do not have access.
export default function NoAccess() {
  return (
    <main>
      <h1>You are signed in, but not as an operator</h1>
      <p className="lede">
        This tool is limited to named operators because it shows real client information and can send
        email on a business&apos;s behalf. Your account is not on that list. If it should be, ask whoever
        runs the orchestrator to add your address — then sign in again.
      </p>
      <form action="/api/auth/signout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
