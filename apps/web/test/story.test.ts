import { describe, expect, it } from "vitest";

import { snippets } from "../../../scripts/site-data.js";
import { STORY, STORY_ANSWER, STORY_CODE } from "../components/landing/content.js";

const line = (number: number) => STORY_CODE.split("\n")[number - 1] ?? "";

describe("the landing page walkthrough", () => {
  it("shows apps/web/snippets/story.ts, which is type-checked against the library", () => {
    expect(STORY_CODE).toBe(snippets().story);
  });

  it("points each step at the code it explains", () => {
    const expected: Record<string, RegExp> = {
      source: /source: google\.calendar\.invites\(\)/,
      context: /profile:/,
      question: /importance: choice|critical:|useful:|skip:/,
      judgment: /critical:|useful:|skip:/,
      policy: /invites\.on\(/,
      action: /respond\("accepted"\)|notify\(/,
    };
    for (const step of STORY) {
      for (const number of step.lines) expect(line(number), `${step.id}, line ${number}`).toMatch(expected[step.id]!);
      const [first, last] = step.excerpt;
      expect(first <= last && step.lines.every((number) => number >= first && number <= last), step.id).toBe(true);
    }
    for (const [number, answer] of Object.entries(STORY_ANSWER)) expect(line(Number(number))).toContain(`${answer.label}:`);
  });
});
