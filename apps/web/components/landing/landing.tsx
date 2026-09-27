// The home page: a console of monitors at work, one monitor walked through step by step, then the
// ways in. LandingShell gives it and the Try it page their own nav, footer and theme (landing.css),
// separate from the docs.
import Link from 'next/link';
import type { ReactNode } from 'react';

import { site } from '@/lib/site';
import { archivo } from './fonts';
import { Hero } from './hero';
import { Nav } from './nav';
import { Reveal } from './reveal';
import { Closing, Integrations, Logos, WhyJev } from './sections';
import { Story } from './story';
import { Mark } from './ui';
import './landing.css';

export function LandingShell({ children }: { children: ReactNode }) {
  return (
    <div className={`landing ${archivo.variable} min-h-screen font-sans antialiased`}>
      <Nav />
      {children}
      <Footer />
    </div>
  );
}

export function Landing() {
  return (
    <Reveal>
      <main>
        <Hero />
        <Logos />
        <Story />
        <WhyJev />
        <Integrations />
        <Closing />
      </main>
    </Reveal>
  );
}

function Footer() {
  return (
    <footer className="border-t border-[var(--line)]">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-6 px-6 py-10 text-[13px] text-[var(--dim)]">
        <div className="flex items-center gap-2.5 text-[var(--muted)]">
          <Mark className="size-5" /> {site.name}
        </div>
        <p>
          A community project built on{' '}
          <a href={site.typesafe} className="underline decoration-[var(--line-2)] underline-offset-4 transition-colors hover:text-[var(--muted)]">
            TypeSafe&apos;s Jev
          </a>
          . Not affiliated with TypeSafe.
        </p>
        <nav aria-label="Footer" className="flex gap-5">
          <Link href="/docs" className="transition-colors hover:text-[var(--fg)]">
            Docs
          </Link>
          <a href={site.github} className="transition-colors hover:text-[var(--fg)]">
            GitHub
          </a>
          <a href={site.npm} className="transition-colors hover:text-[var(--fg)]">
            npm
          </a>
        </nav>
      </div>
    </footer>
  );
}
