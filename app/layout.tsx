import type { Metadata } from 'next';
import './globals.css';

// Real metadata, not the scaffold default — PRODUCT_STANDARDS §7.
export const metadata: Metadata = {
  title: 'Orchestrator — what should happen, and who must approve it',
  description: 'Threshold sweeps, delegation gates and the review queue for the flow registry.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU">
      <body>{children}</body>
    </html>
  );
}
