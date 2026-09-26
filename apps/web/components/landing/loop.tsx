'use client';

// A small engine for the hero console: identical tracks of items that slide right in lockstep. The
// console draws each lane's track once per layer (incoming, judged, and lit), each clipped at Jev's
// playhead, so an item seems to change exactly where it crosses it.
import gsap from 'gsap';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

export function mod(n: number, m: number) {
  return ((n % m) + m) % m;
}

/** Width of an element, re-measured (debounced) when it resizes. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setWidth(Math.round(el.clientWidth)), 150);
    });
    observer.observe(el);
    setWidth(Math.round(el.clientWidth));
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);
  return [ref, width] as const;
}

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface Slot<T> {
  item: T;
  /** Left edge within one period of the track. */
  left: number;
  width: number;
}

export interface Lane<T> {
  slots: Slot<T>[];
  /** The track repeats every `period` px. */
  period: number;
  /** px per second, to the right. */
  speed: number;
  /** Where the loop starts (and stays, for reduced motion), in px. */
  offset: number;
  /** How many periods to draw so the track always covers the viewport. */
  copies: number;
}

/** Lays items out left to right with the given widths and gaps. */
export function lay<T>(items: T[], width: (item: T, i: number) => number, gap: (i: number) => number) {
  let x = 0;
  const slots = items.map((item, i) => {
    const slot = { item, left: x, width: width(item, i) };
    x += slot.width + gap(i);
    return slot;
  });
  return { slots, period: x };
}

/** The offset that puts `slot`'s left edge at `at` px when the loop starts. */
export function offsetFor(slot: Slot<unknown>, period: number, at: number) {
  return mod(at - slot.left, period);
}

export function copiesFor(period: number, viewport: number) {
  return Math.ceil(viewport / period) + 1;
}

/** One lane's track: `copies` periods of slots, moved by useLoop. */
export function Track<T>({
  lane,
  data,
  render,
}: {
  lane: number;
  data: Lane<T>;
  render: (slot: Slot<T>, left: number, key: string) => ReactNode;
}) {
  return (
    <div
      data-track
      data-lane={lane}
      className="absolute inset-y-0 left-0 will-change-transform"
      style={{ width: data.period * data.copies }}
    >
      {Array.from({ length: data.copies }, (_, c) => data.slots.map((s, i) => render(s, c * data.period + s.left, `${c}-${i}`)))}
    </div>
  );
}

/**
 * Moves every `[data-track][data-lane="i"]` under `root` to the right at lane i's speed, wrapping
 * every period, so the copies of a lane in different clip layers stay in lockstep. `onFrame` gets
 * each lane's x after every frame. Pauses off screen and holds still for reduced motion. `lanes`
 * must be memoized.
 */
export function useLoop(root: RefObject<HTMLElement | null>, lanes: Lane<unknown>[], onFrame?: (xs: number[]) => void) {
  const frame = useRef(onFrame);
  useEffect(() => {
    frame.current = onFrame;
  }, [onFrame]);

  useEffect(() => {
    const el = root.current;
    if (!el || lanes.length === 0) return;
    const setters = lanes.map((_, i) =>
      Array.from(el.querySelectorAll<HTMLElement>(`[data-track][data-lane="${i}"]`)).map((t) => gsap.quickSetter(t, 'x', 'px')),
    );
    const xs = lanes.map(() => 0);
    let elapsed = 0;
    let visible = true;

    const render = () => {
      lanes.forEach((l, i) => {
        const x = mod(l.offset + l.speed * elapsed, l.period) - l.period;
        xs[i] = x;
        for (const set of setters[i]!) set(x);
      });
      frame.current?.(xs);
    };
    render();
    if (prefersReducedMotion()) return;

    const tick = (_time: number, deltaMs: number) => {
      if (!visible) return;
      elapsed += Math.min(deltaMs, 64) / 1000;
      render();
    };
    const io = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });
    io.observe(el);
    gsap.ticker.add(tick);
    return () => {
      gsap.ticker.remove(tick);
      io.disconnect();
    };
  }, [root, lanes]);
}

/**
 * Returns an onFrame handler that calls `onCross(lane, slot)` whenever a slot's `point` (px from
 * its left edge) passes x = `at`, moving right.
 */
export function watchCrossings(
  lanes: Lane<unknown>[],
  at: number,
  point: (slot: Slot<unknown>) => number,
  onCross: (lane: number, slot: number) => void,
) {
  const prev = lanes.map((l) => l.slots.map(() => Number.NaN));
  return (xs: number[]) => {
    lanes.forEach((l, li) => {
      const x = xs[li]!;
      l.slots.forEach((s, si) => {
        const phase = mod(s.left + point(s) + x - at, l.period);
        // The phase only grows, except when a copy of this slot passes `at` and it wraps to 0.
        if (phase < prev[li]![si]!) onCross(li, si);
        prev[li]![si] = phase;
      });
    });
  };
}
