/**
 * Publish eval results to the website: npm run eval:report
 *
 * Reads evals/results/*.json (never results/mock) and writes apps/web/generated/benchmarks.json,
 * which the benchmarks page and the landing page render. Nothing else feeds those numbers.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { EvalReport } from "./lib/metrics.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RESULTS = join(ROOT, "evals", "results");
const OUT = join(ROOT, "apps", "web", "generated", "benchmarks.json");

/** What the website shows of one run: the scores on clear-cut examples, without the mistakes list. */
export function publishedRun(report: EvalReport) {
  return {
    dataset: report.dataset,
    mode: report.mode,
    model: report.model,
    date: report.date,
    items: report.items,
    answered: report.answered,
    errors: report.errors,
    requests: report.requests,
    latencyMs: report.latencyMs,
    tokens: report.tokens,
    kind: report.kind.clear,
    flags: Object.fromEntries(Object.entries(report.flags).map(([flag, scores]) => [flag, scores.clear])),
    slices: report.slices,
  };
}

export type PublishedRun = ReturnType<typeof publishedRun>;

export interface BenchmarksFile {
  generatedAt: string | null;
  runs: PublishedRun[];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runs = (existsSync(RESULTS) ? readdirSync(RESULTS) : [])
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(RESULTS, file), "utf8")) as EvalReport)
    .filter((report) => !report.mock)
    .sort((a, b) => a.mode.localeCompare(b.mode))
    .map(publishedRun);
  const file: BenchmarksFile = { generatedAt: runs.length > 0 ? new Date().toISOString() : null, runs };
  writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`);
  process.stdout.write(
    runs.length > 0 ? `published ${runs.length} runs to apps/web/generated/benchmarks.json\n` : "no results yet; run `npm run eval` first\n",
  );
}
