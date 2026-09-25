import { describe, expect, it } from "vitest";

import type { ChatExample } from "../lib/dataset.js";
import { binaryAt, buildReport, kindReport, percentile, type Prediction } from "../lib/metrics.js";

const example = (id: string, extra: Partial<ChatExample>): ChatExample => ({ id, text: id, lang: "en", ...extra });
const prediction = (id: string, extra: Partial<Prediction>): Prediction => ({
  id,
  kind: undefined,
  flags: {},
  latencyMs: 100,
  inputTokens: 200,
  ...extra,
});

describe("metrics", () => {
  it("scores a binary judgment at a threshold", () => {
    const pairs = [
      { truth: true, p: 0.95 },
      { truth: true, p: 0.6 },
      { truth: false, p: 0.7 },
      { truth: false, p: 0.1 },
    ];
    expect(binaryAt(pairs, 0.5)).toMatchObject({ tp: 2, fp: 1, fn: 0, tn: 1, precision: 2 / 3, recall: 1, falsePositiveRate: 0.5 });
    expect(binaryAt(pairs, 0.9)).toMatchObject({ tp: 1, fp: 0, fn: 1, tn: 2, precision: 1, recall: 0.5 });
    expect(binaryAt([], 0.5)).toMatchObject({ precision: null, recall: null, f1: null });
  });

  it("uses nearest-rank percentiles", () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([], 50)).toBeNull();
  });

  it("counts accepted alternatives separately from exact kind matches", () => {
    const examples = [
      example("a", { kind: "joke", kindAlso: ["other"] }),
      example("b", { kind: "question" }),
      example("c", { kind: "hype" }),
    ];
    const predictions = new Map([
      ["a", prediction("a", { kind: { choice: "other", confidence: 0.6 } })],
      ["b", prediction("b", { kind: { choice: "question", confidence: 0.95 } })],
      ["c", prediction("c", { kind: { choice: "joke", confidence: 0.4 } })],
    ]);
    const report = kindReport(examples, predictions);
    expect(report.accuracy).toBeCloseTo(1 / 3);
    expect(report.lenientAccuracy).toBeCloseTo(2 / 3);
    expect(report.confusion).toEqual({ joke: { other: 1 }, question: { question: 1 }, hype: { joke: 1 } });
    expect(report.byConfidence.find((row) => row.min === 0.9)).toEqual({ min: 0.9, coverage: 1 / 3, lenientAccuracy: 1 });
  });

  it("builds a report with clear-case numbers, slices, cost and mistakes", () => {
    const examples = [
      example("x1", { flags: ["hateful"] }),
      example("x2", { flags: ["hateful"], borderline: true }),
      example("n1", { kind: "other", lang: "de", tags: ["hard-negative"] }),
    ];
    const predictions = new Map([
      ["x1", prediction("x1", { flags: { hateful: 0.97 } })],
      ["x2", prediction("x2", { flags: { hateful: 0.2 } })],
      ["n1", prediction("n1", { kind: { choice: "other", confidence: 0.8 }, flags: { hateful: 0.6 }, latencyMs: 300 })],
    ]);
    const report = buildReport({
      dataset: "chat",
      mode: "single",
      model: "jev-test",
      mock: true,
      examples,
      predictions,
      errors: 0,
      requests: 3,
      usdPerMillionInputTokens: 0.042,
    });
    const at = (t: number) => report.flags.hateful?.clear.thresholds.find((score) => score.threshold === t);
    expect(at(0.5)).toMatchObject({ tp: 1, fp: 1, fn: 0 });
    expect(report.flags.hateful?.all.positives).toBe(2);
    expect(report.slices["non-english"]).toMatchObject({ n: 1, hatefulFalsePositives: 1, kindAccuracy: 1 });
    expect(report.tokens).toEqual({ inputPerItem: 200, totalInput: 600, usdPer1kItems: 0.0084 });
    expect(report.latencyMs.p50).toBe(100);
    expect(report.mistakes.map((m) => `${m.id}:${m.expected}`)).toEqual(["x2:hateful=true", "n1:hateful=false"]);
  });
});
