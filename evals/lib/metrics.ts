import { FLAGS, KINDS, hasFlag, type ChatExample, type Flag, type Kind } from "./dataset.js";

/** One example's answers, however they were obtained. */
export interface Prediction {
  id: string;
  kind: { choice: string; confidence: number } | undefined;
  /** Probability of yes for each noul recipe. */
  flags: Partial<Record<Flag, number>>;
  /** How long this example waited for its answer. */
  latencyMs: number;
  /** This example's share of the request's input tokens. */
  inputTokens: number;
}

export interface BinaryScore {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** Share of true negatives that were flagged anyway. */
  falsePositiveRate: number | null;
}

export const THRESHOLDS = [0.3, 0.5, 0.7, 0.8, 0.9] as const;

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

export function binaryAt(pairs: ReadonlyArray<{ truth: boolean; p: number }>, threshold: number): BinaryScore {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const { truth, p } of pairs) {
    const fired = p >= threshold;
    if (fired && truth) tp++;
    else if (fired) fp++;
    else if (truth) fn++;
    else tn++;
  }
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall);
  return { threshold, tp, fp, fn, tn, precision, recall, f1, falsePositiveRate: ratio(fp, fp + tn) };
}

/** Nearest-rank percentile. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? null;
}

export interface FlagReport {
  positives: number;
  negatives: number;
  thresholds: BinaryScore[];
  /** The threshold with the best F1 among THRESHOLDS. */
  best: BinaryScore | null;
}

export function flagReport(examples: readonly ChatExample[], predictions: ReadonlyMap<string, Prediction>, flag: Flag): FlagReport {
  const pairs = examples.flatMap((example) => {
    const p = predictions.get(example.id)?.flags[flag];
    return p === undefined ? [] : [{ truth: hasFlag(example, flag), p }];
  });
  const thresholds = THRESHOLDS.map((threshold) => binaryAt(pairs, threshold));
  const best = thresholds.reduce<BinaryScore | null>((top, score) => ((score.f1 ?? -1) > (top?.f1 ?? -1) ? score : top), null);
  const positives = pairs.filter((pair) => pair.truth).length;
  return { positives, negatives: pairs.length - positives, thresholds, best };
}

export interface KindReport {
  n: number;
  /** The chosen label is the gold label. */
  accuracy: number | null;
  /** The chosen label is the gold label or one of its accepted alternatives. */
  lenientAccuracy: number | null;
  perLabel: Record<string, { gold: number; predicted: number; precision: number | null; recall: number | null }>;
  /** gold label → predicted label → count. */
  confusion: Record<string, Record<string, number>>;
  /** Accuracy on the answers at or above a confidence, and how many answers that keeps. */
  byConfidence: Array<{ min: number; coverage: number | null; lenientAccuracy: number | null }>;
}

export function kindReport(examples: readonly ChatExample[], predictions: ReadonlyMap<string, Prediction>): KindReport {
  const rows = examples.flatMap((example) => {
    const kind = predictions.get(example.id)?.kind;
    if (!example.kind || !kind) return [];
    const accepted = new Set<string>([example.kind, ...(example.kindAlso ?? [])]);
    return [{ gold: example.kind, choice: kind.choice, confidence: kind.confidence, strict: kind.choice === example.kind, lenient: accepted.has(kind.choice) }];
  });

  const confusion: KindReport["confusion"] = {};
  for (const row of rows) {
    const line = (confusion[row.gold] ??= {});
    line[row.choice] = (line[row.choice] ?? 0) + 1;
  }
  const perLabel: KindReport["perLabel"] = {};
  for (const label of KINDS as readonly Kind[]) {
    const gold = rows.filter((row) => row.gold === label).length;
    const predicted = rows.filter((row) => row.choice === label).length;
    const correct = rows.filter((row) => row.gold === label && row.choice === label).length;
    perLabel[label] = { gold, predicted, precision: ratio(correct, predicted), recall: ratio(correct, gold) };
  }
  const byConfidence = [0, 0.5, 0.7, 0.9].map((min) => {
    const kept = rows.filter((row) => row.confidence >= min);
    return { min, coverage: ratio(kept.length, rows.length), lenientAccuracy: ratio(kept.filter((row) => row.lenient).length, kept.length) };
  });

  return {
    n: rows.length,
    accuracy: ratio(rows.filter((row) => row.strict).length, rows.length),
    lenientAccuracy: ratio(rows.filter((row) => row.lenient).length, rows.length),
    perLabel,
    confusion,
    byConfidence,
  };
}

export interface SliceReport {
  n: number;
  /** Lenient kind accuracy on the slice's examples that have a kind. */
  kindAccuracy: number | null;
  /** Share of the slice's examples whose hateful answer (at p ≥ 0.5) matches the label. */
  hatefulAgreement: number | null;
  hatefulFalsePositives: number;
  hatefulMisses: number;
}

export function sliceReport(examples: readonly ChatExample[], predictions: ReadonlyMap<string, Prediction>): SliceReport {
  let kindTotal = 0;
  let kindRight = 0;
  let hatefulTotal = 0;
  let hatefulRight = 0;
  let falsePositives = 0;
  let misses = 0;
  for (const example of examples) {
    const prediction = predictions.get(example.id);
    if (!prediction) continue;
    if (example.kind && prediction.kind) {
      kindTotal++;
      if ([example.kind, ...(example.kindAlso ?? [])].includes(prediction.kind.choice as Kind)) kindRight++;
    }
    const p = prediction.flags.hateful;
    if (p !== undefined) {
      hatefulTotal++;
      const truth = hasFlag(example, "hateful");
      const fired = p >= 0.5;
      if (truth === fired) hatefulRight++;
      else if (fired) falsePositives++;
      else misses++;
    }
  }
  return {
    n: examples.length,
    kindAccuracy: ratio(kindRight, kindTotal),
    hatefulAgreement: ratio(hatefulRight, hatefulTotal),
    hatefulFalsePositives: falsePositives,
    hatefulMisses: misses,
  };
}

/** Slices worth reporting: non-English text and each tag. */
export function slices(examples: readonly ChatExample[]): Record<string, ChatExample[]> {
  const groups: Record<string, ChatExample[]> = {
    english: examples.filter((example) => example.lang === "en"),
    "non-english": examples.filter((example) => example.lang !== "en"),
  };
  for (const example of examples) {
    for (const tag of example.tags ?? []) (groups[tag] ??= []).push(example);
  }
  return groups;
}

export interface EvalReport {
  dataset: string;
  mode: string;
  model: string;
  date: string;
  /** Produced by the offline mock. Never published. */
  mock: boolean;
  items: number;
  answered: number;
  errors: number;
  requests: number;
  latencyMs: { p50: number | null; p95: number | null; mean: number | null };
  tokens: { inputPerItem: number | null; totalInput: number; usdPer1kItems: number | null };
  flags: Record<string, { all: FlagReport; clear: FlagReport }>;
  kind: { all: KindReport; clear: KindReport };
  slices: Record<string, SliceReport>;
  /** Examples the model got wrong at p ≥ 0.5, for error analysis. */
  mistakes: Array<{ id: string; text: string; expected: string; got: string }>;
}

export function buildReport(input: {
  dataset: string;
  mode: string;
  model: string;
  mock: boolean;
  examples: readonly ChatExample[];
  predictions: ReadonlyMap<string, Prediction>;
  errors: number;
  requests: number;
  usdPerMillionInputTokens: number;
}): EvalReport {
  const { examples, predictions } = input;
  const clear = examples.filter((example) => !example.borderline);
  const answered = [...predictions.values()];
  const latencies = answered.map((prediction) => prediction.latencyMs);
  const totalInput = answered.reduce((sum, prediction) => sum + prediction.inputTokens, 0);
  const inputPerItem = answered.length === 0 ? null : totalInput / answered.length;

  const flags: EvalReport["flags"] = {};
  for (const flag of FLAGS) {
    flags[flag] = { all: flagReport(examples, predictions, flag), clear: flagReport(clear, predictions, flag) };
  }

  const mistakes: EvalReport["mistakes"] = [];
  for (const example of examples) {
    const prediction = predictions.get(example.id);
    if (!prediction) continue;
    for (const flag of FLAGS) {
      const p = prediction.flags[flag];
      if (p === undefined || p >= 0.5 === hasFlag(example, flag)) continue;
      mistakes.push({ id: example.id, text: example.text, expected: `${flag}=${hasFlag(example, flag)}`, got: `${flag} p=${p.toFixed(2)}` });
    }
    const accepted = example.kind ? [example.kind, ...(example.kindAlso ?? [])] : [];
    if (prediction.kind && example.kind && !accepted.includes(prediction.kind.choice as Kind)) {
      mistakes.push({ id: example.id, text: example.text, expected: `kind=${accepted.join("|")}`, got: `kind=${prediction.kind.choice} (${prediction.kind.confidence.toFixed(2)})` });
    }
  }

  return {
    dataset: input.dataset,
    mode: input.mode,
    model: input.model,
    date: new Date().toISOString(),
    mock: input.mock,
    items: examples.length,
    answered: answered.length,
    errors: input.errors,
    requests: input.requests,
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      mean: latencies.length === 0 ? null : latencies.reduce((a, b) => a + b, 0) / latencies.length,
    },
    tokens: {
      inputPerItem,
      totalInput,
      usdPer1kItems: inputPerItem === null ? null : (inputPerItem * 1000 * input.usdPerMillionInputTokens) / 1_000_000,
    },
    flags,
    kind: { all: kindReport(examples, predictions), clear: kindReport(clear, predictions) },
    slices: Object.fromEntries(Object.entries(slices(examples)).map(([name, group]) => [name, sliceReport(group, predictions)])),
    mistakes,
  };
}
