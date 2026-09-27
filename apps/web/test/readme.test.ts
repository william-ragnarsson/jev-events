import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { snippets } from "../../../scripts/site-data.js";

/** The TypeScript blocks in a README of this repo. */
function codeIn(path: string): string[] {
  const markdown = readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
  return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]!.trim());
}

describe("the READMEs", () => {
  // Each one shows a website snippet, which is type-checked against the library, so the READMEs
  // can't drift from the API unnoticed.
  it.each([
    ["README.md", "story"],
    ["packages/core/README.md", "quickstart"],
    ["packages/google/README.md", "google"],
    ["packages/slack/README.md", "slack"],
    ["packages/twitch/README.md", "twitch"],
  ] as const)("%s shows apps/web/snippets/%s.ts", (path, name) => {
    expect(codeIn(path)).toContain(snippets()[name]);
  });
});
