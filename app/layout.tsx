import type { Metadata } from 'next';
import './globals.css';
import { OperatorNav } from '@/components/OperatorNav';
import { currentAdmin } from '@/lib/supabase-auth';

export const metadata: Metadata = {
  title: 'Orchestrator — what should happen, and who must approve it',
  description: 'Threshold sweeps, delegation gates and the review queue for the flow registry.',
};

// The chrome is applied HERE rather than per page, so a new page cannot ship without it. That is how
// /queue came to have no navigation at all: nothing forced it to.
//
// Pages a signed-out person can legitimately reach (/login, /unsubscribe, /no-access) render bare —
// there is no session to hang a nav off, and putting "Sign out" on a login screen is nonsense.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const operator = await currentAdmin();

  return (
    <html lang="en-AU">
      <body>
        {operator ? (
          <div className="app-shell">
            <OperatorNav email={operator.email} />
            <div className="app-main">{children}</div>
          </div>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
