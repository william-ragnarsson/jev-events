import type { ReactNode } from 'react';

// The home page and the Try it page. Each page puts in its own nav, since the home page's is on blue.
export default function HomeLayout({ children }: { children: ReactNode }) {
  return <div className="site">{children}</div>;
}
