'use client';

import Link from 'next/link';
import type { MouseEvent } from 'react';

import { site } from '@/lib/site';
import { GitHubIcon } from '../brand-icons';
import { prefersReducedMotion } from './loop';
import { Mark } from './ui';

const LINKS = [
  { href: '#how', label: 'How it works' },
  { href: '#integrations', label: 'Integrations' },
  { href: '/docs/recipes', label: 'Recipes' },
  { href: '/docs', label: 'Docs' },
];

/** Scrolls to a section on this page without leaving a history entry per click. */
function jump(e: MouseEvent<HTMLAnchorElement>) {
  const { hash } = e.currentTarget;
  const target = hash ? document.getElementById(hash.slice(1)) : null;
  if (!target) return;
  e.preventDefault();
  target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  history.replaceState(null, '', hash);
}

export function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[color-mix(in_oklab,var(--bg)_70%,transparent)] backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-9 px-6">
        <Link href="/" className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight">
          <Mark className="size-6" />
          {site.name}
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-7 text-[13.5px] text-[var(--muted)] md:flex">
          {LINKS.map((l) =>
            l.href.startsWith('#') ? (
              <a key={l.href} href={l.href} onClick={jump} className="transition-colors hover:text-[var(--fg)]">
                {l.label}
              </a>
            ) : (
              <Link key={l.href} href={l.href} className="transition-colors hover:text-[var(--fg)]">
                {l.label}
              </Link>
            ),
          )}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <a
            href={site.github}
            className="hidden items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-[var(--muted)] transition-colors hover:text-[var(--fg)] sm:flex"
          >
            <GitHubIcon aria-hidden className="size-4" /> GitHub
          </a>
          <Link
            href="/docs/quickstart"
            className="rounded-md bg-[var(--fg)] px-3 py-1.5 text-[13px] font-medium text-[var(--bg)] transition-opacity hover:opacity-90"
          >
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}
