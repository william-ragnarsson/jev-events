import { describe, expectTypeOf, it } from "vitest";

import type * as Evals from "../../../evals/report.js";
import type * as Web from "../lib/benchmark-types.js";

describe("benchmarks.json", () => {
  it("has the shape evals/report.ts writes", () => {
    expectTypeOf<Web.BenchmarkRun>().toEqualTypeOf<Evals.PublishedRun>();
    expectTypeOf<Web.BenchmarksFile>().toEqualTypeOf<Evals.BenchmarksFile>();
  });
});
