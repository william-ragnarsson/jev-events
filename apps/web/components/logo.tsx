import { createElement, type SVGProps } from "react";

import { BRAND, MARK, TILE_RADIUS } from "@/lib/brand";

/**
 * The Jev Events mark (see lib/brand.ts), for the navs, the footer and the social cards. Unlike the
 * favicon, its tile has a faint edge in the text color, so it holds on the near-black pages too.
 */
export function Logo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" {...props}>
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx={TILE_RADIUS - 0.5}
        fill={BRAND.tile}
        stroke="currentColor"
        strokeOpacity={0.16}
      />
      {MARK.map(([tag, attributes], index) => createElement(tag, { key: index, ...attributes }))}
    </svg>
  );
}
