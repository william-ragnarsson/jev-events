import { createElement, type SVGProps } from "react";

import { mark, type Tone } from "@/lib/brand";

/**
 * The Jev Events mark (see lib/brand.ts) without its tile, for the navs and the social cards:
 * `field` on the blue, `paper` on the cream pages.
 */
export function Logo({ tone = "paper", ...props }: SVGProps<SVGSVGElement> & { tone?: Tone }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" {...props}>
      {mark(tone).map(([tag, attributes], index) => createElement(tag, { key: index, ...attributes }))}
    </svg>
  );
}
