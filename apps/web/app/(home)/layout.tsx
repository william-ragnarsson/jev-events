import type { ReactNode } from 'react';

import { LandingShell } from '@/components/landing/landing';

// The home page and the Try it page share the landing's nav, footer and theme; the docs have their own.
export default function HomeLayout({ children }: { children: ReactNode }) {
  return <LandingShell>{children}</LandingShell>;
}
