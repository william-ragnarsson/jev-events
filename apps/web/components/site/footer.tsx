import Link from 'next/link';

import { site } from '@/lib/site';
import './site.css';

/**
 * The bottom of every page. On the home page it sits inside the blue closing section, in cream;
 * on the paper pages (`onPaper`) it's pushed to the bottom of the page, in ink.
 */
export function Footer({ onPaper = false }: { onPaper?: boolean }) {
  return (
    <footer className={onPaper ? 'site-footer on-paper' : 'site-footer'}>
      <p>A community project built on TypeSafe&apos;s Jev. Not affiliated with TypeSafe.</p>
      <nav aria-label="Footer">
        <ul>
          <li>
            <Link href="/docs">Docs</Link>
          </li>
          <li>
            <a href={site.github}>GitHub</a>
          </li>
          <li>
            <a href={site.npm}>npm</a>
          </li>
        </ul>
      </nav>
    </footer>
  );
}
