import type { SVGProps } from "react";

/**
 * A stream of items with one picked out: what Jev Events does. The tile is dark in both themes, so
 * the signal bar keeps its contrast; the favicon and social images use the same colors.
 */
export function Logo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" {...props}>
      <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="#0a0a0a" className="stroke-fd-border" />
      <rect x="7" y="8.5" width="11" height="3" rx="1.5" fill="#fafafa" opacity="0.55" />
      <rect x="7" y="14.5" width="18" height="3" rx="1.5" fill="#c0f84f" />
      <rect x="7" y="20.5" width="8" height="3" rx="1.5" fill="#fafafa" opacity="0.55" />
    </svg>
  );
}
