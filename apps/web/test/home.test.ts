import { describe, expect, it } from "vitest";

import { snippets } from "../../../scripts/site-data.js";
import { HOME_CODE, HOME_MARKS, HOME_STEPS } from "../components/home/code.js";

const lines = HOME_CODE.split("\n");

describe("the home page walkthrough", () => {
  it("shows apps/web/snippets/home.ts, which is type-checked against the library", () => {
    expect(HOME_CODE).toBe(snippets().home);
  });

  it("marks code that's there, in order", () => {
    let from = 0;
    for (const mark of HOME_MARKS) {
      const at = HOME_CODE.indexOf(mark.code, from);
      expect(at, mark.code).toBeGreaterThanOrEqual(from);
      from = at + mark.code.length;
    }
  });

  it("puts each step on the rail beside its first mark", () => {
    for (const step of HOME_STEPS) {
      const mark = HOME_MARKS.find((m) => m.step === step.step)!;
      expect(lines[step.line - 1], step.label).toContain(mark.code);
    }
  });
});
