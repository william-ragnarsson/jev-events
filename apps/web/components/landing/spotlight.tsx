'use client';

import type { MouseEvent, ReactNode } from 'react';

/** Moves a soft light under the pointer across whichever `[data-spot]` card it is over. */
export function SpotlightGrid({ className, children }: { className?: string; children: ReactNode }) {
  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-spot]');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  };

  return (
    <div data-reveal onMouseMove={onMove} className={className}>
      {children}
    </div>
  );
}
