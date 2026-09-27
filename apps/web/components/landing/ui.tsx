// Small pieces the landing sections share.
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { COPY } from './content';

/** The Jev Events mark: a stream of items with one picked out, in the page's accent. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="#0b0c0f" stroke="rgb(255 255 255 / 0.16)" />
      <rect x="7" y="8.5" width="11" height="3" rx="1.5" fill="#fafafa" opacity="0.5" />
      <rect x="7" y="14.5" width="18" height="3" rx="1.5" className="fill-[var(--accent)]" />
      <rect x="7" y="20.5" width="8" height="3" rx="1.5" fill="#fafafa" opacity="0.5" />
    </svg>
  );
}

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
