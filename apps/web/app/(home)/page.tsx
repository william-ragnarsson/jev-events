import type { Metadata } from 'next';

import { Landing } from '@/components/landing/landing';
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
  return <Landing />;
}
