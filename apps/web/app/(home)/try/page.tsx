import type { Metadata } from 'next';

import { TryIt } from '@/components/landing/try-it';
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
    <main>
      <TryIt />
    </main>
  );
}
