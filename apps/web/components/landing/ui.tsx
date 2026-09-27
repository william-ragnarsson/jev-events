// Small pieces the landing sections share.
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { COPY } from './content';

/** The type of every section heading. */
export const H2 = 'text-[clamp(2rem,4vw,3.2rem)] leading-[1.04] font-semibold tracking-[-0.035em] text-balance';

export function Kicker({ children }: { children: ReactNode }) {
  return <p className="font-mono text-[11.5px] tracking-[0.16em] text-[var(--accent)] uppercase">{children}</p>;
}

export function QuickstartLink() {
  return (
    <Link
      href="/docs/quickstart"
      className="group inline-flex h-11 items-center gap-2.5 rounded-md bg-[var(--accent)] pr-4 pl-5 text-[14.5px] font-medium text-[var(--accent-ink)] transition-[filter] hover:brightness-110"
    >
      {COPY.quickstart}
      <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-0.5" />
    </Link>
  );
}

/** The other way in, next to the quickstart: the live Twitch demo at /try. */
export function TryLink() {
  return (
    <Link
      href="/try"
      className="inline-flex h-11 items-center gap-2.5 rounded-md border border-[var(--line-2)] px-5 text-[14.5px] font-medium transition-colors hover:bg-white/[0.05]"
    >
      <span aria-hidden className="landing-live-dot size-1.5 rounded-full bg-[var(--accent)]" />
      {COPY.tryIt}
    </Link>
  );
}
