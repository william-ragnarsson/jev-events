import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { GENERATED, serialize, siteData } from "../../../scripts/site-data.js";

describe("website data", () => {
  it("matches the library; run `npm run site:data` if this fails", () => {
    for (const [file, value] of Object.entries(siteData())) {
      const path = `${GENERATED}${file}`;
      expect(existsSync(path), `${file} is missing`).toBe(true);
      expect(readFileSync(path, "utf8"), `${file} is stale`).toBe(serialize(value));
    }
  });
});
