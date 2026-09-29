import type { Metadata } from 'next';

import { Footer } from '@/components/site/footer';
import { Nav } from '@/components/site/nav';
import { TryIt } from '@/components/try/try-it';
import { site } from '@/lib/site';

const title = 'Try it in your browser';
const description =
  'Point Jev at a live Twitch chat and watch it answer your question about each new message, on your own TypeSafe key. Nothing to install.';

export const metadata: Metadata = {
  title,
  description,
  openGraph: { type: 'website', siteName: site.name, url: `${site.url}/try`, title: `${title} · ${site.name}`, description },
  twitter: { card: 'summary_large_image', title: `${title} · ${site.name}`, description },
};

export default function TryPage() {
  return (
    <>
      <Nav current="/try" />
      <main id="main" className="try">
        <TryIt />
      </main>
      <Footer onPaper />
    </>
  );
}
