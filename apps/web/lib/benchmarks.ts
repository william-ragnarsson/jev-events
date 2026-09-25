import data from '@/generated/benchmarks.json';

import type { BenchmarksFile } from './benchmark-types';

export type * from './benchmark-types';

export const benchmarks = data as unknown as BenchmarksFile;

/** The run the landing page quotes: one request per message, the library's default. */
export const headlineRun = benchmarks.runs.find((run) => run.mode === 'single');

export const percent = (value: number | null | undefined) => (value == null ? '–' : `${Math.round(value * 100)}%`);
