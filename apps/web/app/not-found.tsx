import type { Metadata } from 'next';
import Link from 'next/link';

import { Footer } from '@/components/site/footer';
import { Nav } from '@/components/site/nav';

export const metadata: Metadata = { title: 'Page not found' };

/** Any address with nothing at it, framed like the docs. */
export default function NotFound() {
  return (
    <div className="site">
      <Nav />
      <main id="main" className="not-found">
        <h1>Page not found</h1>
        <p className="not-found-lead">There&apos;s no page at this address. It may have moved, or the link has a typo.</p>
        <p>
          Try the <Link href="/docs">docs</Link>, or go back to the <Link href="/">home page</Link>.
        </p>
      </main>
      <Footer onPaper />
    </div>
  );
}
