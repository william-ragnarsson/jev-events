import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { BRAND, markSvg } from "../lib/brand.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("the logo", () => {
  // The favicon and the apple icon are written in the same run.
  it("is the tab icon; run `npm run site:icons` if this fails", () => {
    expect(read("app/icon.svg")).toBe(markSvg());
  });

  it("is printed in the site's colors", () => {
    const css = read("app/global.css");
    expect(css).toContain(`--color-field: ${BRAND.field};`);
    expect(css).toContain(`--color-cream: ${BRAND.cream};`);
    expect(css).toContain(`--color-ink: ${BRAND.ink};`);
  });
});
