'use client';

// The persistent operator chrome (PRODUCT_STANDARDS §4).
//
// Present on EVERY authenticated route, not just the dashboard — the queue previously had no nav at
// all, so the only way out was the browser's back button and there was no way to sign out on a
// shared machine.
//
// Settings and Sign Out are anchored at the BOTTOM, per the standard. That is not decoration: they
// are the two controls someone looks for when they are already lost, so they live in the same place
// on every screen rather than moving with the content.
//
// Sized for the people who use it. Kira's ICP is an owner in his sixties; this tool's operators are
// not necessarily younger. Targets are 44px+, labels are words rather than icons alone — an
// icon-only control is invisible to anyone who does not already know what it means.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

const LINKS = [
  { href: '/queue', label: 'Review queue', hint: 'Work waiting on a decision' },
  { href: '/tasks', label: 'All work', hint: 'Everything the sweep has raised' },
  { href: '/connections', label: 'Connections', hint: 'Xero and other systems' },
];

export function OperatorNav({ email }: { email: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const item = (l: { href: string; label: string; hint: string }) => {
    const active = pathname === l.href || pathname.startsWith(l.href + '/');
    return (
      <Link
        key={l.href}
        href={l.href}
        onClick={() => setOpen(false)}
        aria-current={active ? 'page' : undefined}
        className={`nav-item${active ? ' nav-item--active' : ''}`}
      >
        <span className="nav-label">{l.label}</span>
        <span className="nav-hint">{l.hint}</span>
      </Link>
    );
  };

  return (
    <>
      {/* Mobile: a labelled button, not a bare hamburger. Three lines with no word next to them is
          the single most common control people in their sixties do not recognise. */}
      <button className="nav-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls="operator-nav">
        {open ? 'Close' : 'Menu'}
      </button>

      <nav id="operator-nav" className={`operator-nav${open ? ' operator-nav--open' : ''}`} aria-label="Main">
        <div className="nav-brand">Orchestrator</div>
        <div className="nav-links">{LINKS.map(item)}</div>

        {/* Anchored bottom — §4. */}
        <div className="nav-foot">
          <div className="nav-who" title={email}>Signed in as<br /><strong>{email}</strong></div>
          {item({ href: '/settings', label: 'Settings', hint: 'Your account' })}
          <form action="/api/auth/signout" method="post">
            <button type="submit" className="nav-signout">Sign out</button>
          </form>
        </div>
      </nav>
      {open && <div className="nav-scrim" onClick={() => setOpen(false)} aria-hidden />}
    </>
  );
}
