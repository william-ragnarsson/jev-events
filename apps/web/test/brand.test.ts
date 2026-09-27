import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { BRAND, markSvg } from "../lib/brand.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("the logo", () => {
  // The favicon and the apple icon are written in the same run.
  it("is the tab icon; run `npm run site:icons` if this fails", () => {
    expect(read("app/icon.svg")).toBe(markSvg());
  });

  it("is lit in the site's accent", () => {
    expect(read("components/landing/landing.css")).toContain(`--accent: ${BRAND.accent};`);
    expect(read("app/global.css")).toContain(`--color-signal: ${BRAND.accent};`);
  });
});
