// The shape evals/report.ts publishes. A test checks these stay identical to the eval types.

export interface BinaryScore {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  falsePositiveRate: number | null;
}

export interface FlagReport {
  positives: number;
  negatives: number;
  thresholds: BinaryScore[];
  best: BinaryScore | null;
}

export interface KindReport {
  n: number;
  accuracy: number | null;
  lenientAccuracy: number | null;
  perLabel: Record<string, { gold: number; predicted: number; precision: number | null; recall: number | null }>;
  confusion: Record<string, Record<string, number>>;
  byConfidence: Array<{ min: number; coverage: number | null; lenientAccuracy: number | null }>;
}

export interface SliceReport {
  n: number;
  kindAccuracy: number | null;
  hatefulAgreement: number | null;
  hatefulFalsePositives: number;
  hatefulMisses: number;
}

export interface BenchmarkRun {
  dataset: string;
  mode: string;
  model: string;
  date: string;
  items: number;
  answered: number;
  errors: number;
  requests: number;
  latencyMs: { p50: number | null; p95: number | null; mean: number | null };
  tokens: { inputPerItem: number | null; totalInput: number; usdPer1kItems: number | null };
  kind: KindReport;
  flags: { [flag: string]: FlagReport };
  slices: Record<string, SliceReport>;
}

export interface BenchmarksFile {
  generatedAt: string | null;
  runs: BenchmarkRun[];
}
