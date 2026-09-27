'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Logo } from '@/components/logo';
import { site } from '@/lib/site';

// Three ways in and nothing else. On phones the middle one is just "Try it".
const LINKS = [
  { href: '/', label: 'Home' },
  { href: '/try', label: 'Try it', more: ' in your browser' },
  { href: '/docs', label: 'Docs' },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[color-mix(in_oklab,var(--bg)_70%,transparent)] backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5 text-[15px] font-semibold tracking-tight">
          <Logo className="size-6" />
          {site.name}
        </Link>
        <nav aria-label="Main" className="ml-auto flex items-center gap-5 text-[13.5px] sm:gap-7">
          {LINKS.map((l) => {
            const current = l.href === '/' ? pathname === '/' : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={current ? 'page' : undefined}
                className={`flex items-center gap-2 whitespace-nowrap transition-colors ${current ? 'text-[var(--fg)]' : 'text-[var(--muted)] hover:text-[var(--fg)]'}`}
              >
                {l.more && <span aria-hidden className="landing-live-dot size-1.5 rounded-full bg-[var(--accent)]" />}
                <span>
                  {l.label}
                  {l.more && <span className="hidden sm:inline">{l.more}</span>}
                </span>
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
