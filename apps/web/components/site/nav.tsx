import Link from 'next/link';

import { Logo } from '@/components/logo';
import { site } from '@/lib/site';
import './site.css';

const LINKS = [
  { href: '/', label: 'Home' },
  { href: '/try', label: 'Try it' },
  { href: '/docs', label: 'Docs' },
] as const;

export type Section = (typeof LINKS)[number]['href'];

/** The top of every page: the logo and three ways in, the current one underlined. */
export function Nav({ tone = 'paper', current }: { tone?: 'field' | 'paper'; current?: Section }) {
  return (
    <header className={tone === 'field' ? 'on-field' : undefined}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <nav aria-label="Main" className="site-nav">
        <Link href="/" className="site-logo">
          <Logo tone={tone} />
          {site.name}
        </Link>
        <ul className="site-links">
          {LINKS.map((link) => (
            <li key={link.href}>
              <Link href={link.href} aria-current={link.href === current ? 'page' : undefined}>
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
