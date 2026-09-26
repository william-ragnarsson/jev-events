'use client';

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useRef, type ReactNode } from 'react';

import { prefersReducedMotion } from './loop';

gsap.registerPlugin(ScrollTrigger, useGSAP);

/**
 * Fades each `[data-reveal]` element inside in as it scrolls into view. Elements that start on
 * screen (or are hidden) are left alone, so nothing blinks on load. Its effect runs after its
 * children's, so the walkthrough's pin spacing is already in place when it measures.
 */
export function Reveal({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const el = root.current;
      if (!el || prefersReducedMotion()) return;
      const fold = window.innerHeight * 0.88;
      const below = Array.from(el.querySelectorAll<HTMLElement>('[data-reveal]')).filter((r) => r.getBoundingClientRect().top > fold);
      if (below.length === 0) return;
      gsap.set(below, { opacity: 0, y: 26 });
      ScrollTrigger.batch(below, {
        start: 'top 88%',
        once: true,
        onEnter: (batch) => {
          // A jump (the End key, a link) can skip past elements; show those at once so the stagger
          // doesn't hold back the ones on screen.
          const passed = batch.filter((r) => r.getBoundingClientRect().bottom < 0);
          const onScreen = batch.filter((r) => !passed.includes(r));
          if (passed.length) gsap.set(passed, { opacity: 1, y: 0 });
          if (onScreen.length) gsap.to(onScreen, { opacity: 1, y: 0, duration: 0.9, stagger: 0.08, ease: 'power3.out' });
        },
      });
    },
    { scope: root },
  );

  return <div ref={root}>{children}</div>;
}
