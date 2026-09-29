import type { Metadata } from 'next';

import { Closing } from '@/components/home/closing';
import { Hero } from '@/components/home/hero';
import { HowItWorks } from '@/components/home/how-it-works';
import { WorksWith } from '@/components/home/works-with';
import { Nav } from '@/components/site/nav';
import { site } from '@/lib/site';

const title = 'Jev Events: Ask every event a question';
const description =
  "A TypeScript library that asks TypeSafe's Jev a question about every new email, invite or message your users get, and runs your code or a native action on the answer.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  openGraph: { type: 'website', siteName: site.name, url: site.url, title, description },
  twitter: { card: 'summary_large_image', title, description },
};

export default function HomePage() {
  return (
    <>
      <Nav tone="field" current="/" />
      <main id="main" className="home">
        <Hero />
        <HowItWorks />
        <WorksWith />
        <Closing />
      </main>
    </>
  );
}
