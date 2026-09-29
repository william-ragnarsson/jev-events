/**
 * The Jev Events mark, drawn once for everywhere it appears: the Logo component (the navs and the
 * social cards) and the files `npm run site:icons` writes from it (app/icon.svg, app/favicon.ico,
 * app/apple-icon.png). Events come in from the left, cross Jev's line, and the one that matters
 * comes out whole, like the emails on the home page's tracks.
 *
 * It's drawn on a 32 × 32 grid with Jev's line on whole pixels, so it stays sharp as a 16 px tab icon.
 */
export const BRAND = {
  /** The blue the home page is printed on, and the docs' links and marked code. */
  field: "#1531C4",
  /** The paper the docs and Try it are printed on, and the type on the blue. */
  cream: "#F4EFE6",
  ink: "#111111",
} as const;

/**
 * The mark's colors on each background: all cream on the blue, ink and blue on the paper, and on
 * Try it's dark Twitch chat, Twitch's light grey with a blue light enough to read there.
 */
export const TONES = {
  field: { line: BRAND.cream, lit: BRAND.cream },
  paper: { line: BRAND.ink, lit: BRAND.field },
  chat: { line: "#EFEFF1", lit: "#6F86FF" },
} as const;

export type Tone = keyof typeof TONES;

export function mark(tone: Tone) {
  const { line, lit } = TONES[tone];
  return [
    // Two events on their way in, the nearer one stronger.
    ["circle", { cx: 5, cy: 16, r: 1.5, fill: line, opacity: 0.3 }],
    ["circle", { cx: 10, cy: 16, r: 2, fill: line, opacity: 0.55 }],
    // Jev's line.
    ["rect", { x: 14, y: 5, width: 2, height: 22, rx: 1, fill: line }],
    // The one that matters.
    ["circle", { cx: 23, cy: 16, r: 5.5, fill: lit }],
  ] as const;
}

/** The mark on a square of the blue, as a standalone SVG file. */
export function markSvg(): string {
  const shapes = mark("field").map(([tag, attributes]) => {
    const list = Object.entries(attributes).map(([name, value]) => `${name}="${value}"`);
    return `  <${tag} ${list.join(" ")}/>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">`,
    `  <rect width="32" height="32" fill="${BRAND.field}"/>`,
    ...shapes,
    `</svg>`,
    ``,
  ].join("\n");
}
