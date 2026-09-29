import { Analytics } from '@vercel/analytics/next';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata, Viewport } from 'next';
import { Inter, Martian_Mono, Schibsted_Grotesk } from 'next/font/google';

import { BRAND } from '@/lib/brand';
import { site } from '@/lib/site';
import './global.css';

const sans = Schibsted_Grotesk({ subsets: ['latin'], variable: '--font-schibsted' });
const mono = Martian_Mono({ subsets: ['latin'], variable: '--font-martian' });
// Only the Twitch chat and the Gmail inbox are set in Inter, so it isn't preloaded on every page.
const ui = Inter({ subsets: ['latin'], variable: '--font-inter', preload: false });

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: {
    default: `${site.name}: ${site.tagline.replace(/\.$/, '')}`,
    template: `%s · ${site.name}`,
  },
  description: site.description,
  openGraph: {
    type: 'website',
    siteName: site.name,
    url: site.url,
    title: site.name,
    description: site.tagline,
  },
  twitter: { card: 'summary_large_image', title: site.name, description: site.tagline },
};

export const viewport: Viewport = {
  themeColor: BRAND.cream,
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${ui.variable}`}>
      <body>
        {/* One light theme; the provider stays for the docs' search dialog. */}
        <RootProvider theme={{ enabled: false }}>{children}</RootProvider>
        <Analytics />
      </body>
    </html>
  );
}
