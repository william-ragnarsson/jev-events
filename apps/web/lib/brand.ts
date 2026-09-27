/**
 * The Jev Events mark, drawn once for everywhere it appears: the Logo component (the navs, the
 * footer, the social cards) and the files `npm run site:icons` writes from it (app/icon.svg,
 * app/favicon.ico, app/apple-icon.png). Events come in from the left, cross Jev's line, and the
 * one that matters comes out lit, like the console on the home page.
 *
 * It's drawn on a 32 × 32 grid with Jev's line on whole pixels, so it stays sharp as a 16 px tab icon.
 */
export const BRAND = {
  /** The tile behind the mark, dark in both themes so the blue keeps its contrast. */
  tile: "#0c0e12",
  ink: "#eceef1",
  /** The site's accent: --accent on the landing page, --color-signal in the dark docs. */
  accent: "#8ab8ff",
} as const;

export const TILE_RADIUS = 7;

export const MARK = [
  // Two events on their way in, the nearer one brighter.
  ["circle", { cx: 5, cy: 16, r: 1.5, fill: BRAND.ink, opacity: 0.3 }],
  ["circle", { cx: 10, cy: 16, r: 2, fill: BRAND.ink, opacity: 0.55 }],
  // Jev's line.
  ["rect", { x: 14, y: 5, width: 2, height: 22, rx: 1, fill: BRAND.ink }],
  // The one that matters.
  ["circle", { cx: 23, cy: 16, r: 5.5, fill: BRAND.accent }],
] as const;

/** The mark on its tile, as a standalone SVG file. */
export function markSvg(): string {
  const shapes = MARK.map(([tag, attributes]) => {
    const list = Object.entries(attributes).map(([name, value]) => `${name}="${value}"`);
    return `  <${tag} ${list.join(" ")}/>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">`,
    `  <rect width="32" height="32" rx="${TILE_RADIUS}" fill="${BRAND.tile}"/>`,
    ...shapes,
    `</svg>`,
    ``,
  ].join("\n");
}
