import type { Item, Source, TriggeredEvent } from "jev-events";

/** Wait until `condition` holds, polling every few milliseconds. */
export async function waitFor(condition: () => boolean, ms = 2_000, what = "the condition"): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error(`Waited ${ms}ms for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export interface Started<I extends Item> {
  items: I[];
  errors: Array<{ error: unknown; fatal: boolean }>;
  warnings: string[];
  /** Settles when `source.start()` does. */
  started: Promise<void>;
  signal: AbortSignal;
  stop(): void;
}

/** Start a source without a listener, collecting what it emits, reports and logs. */
export function startSource<I extends Item>(source: Source<I>): Started<I> {
  const controller = new AbortController();
  const items: I[] = [];
  const errors: Array<{ error: unknown; fatal: boolean }> = [];
  const warnings: string[] = [];
  const note = (message: string, ...args: unknown[]) => void warnings.push([message, ...args].map(String).join(" "));
  const started = Promise.resolve().then(() =>
    source.start({
      emit: (item) => void items.push(item),
      signal: controller.signal,
      log: { debug: () => {}, info: () => {}, warn: note, error: note },
      fail: (error, options) => {
        errors.push({ error, fatal: options?.fatal ?? false });
        if (options?.fatal) controller.abort();
      },
      end: () => {},
    }),
  );
  // Tests that expect start to fail await `started` themselves.
  started.catch(() => {});
  return { items, errors, warnings, started, signal: controller.signal, stop: () => controller.abort() };
}

/** A triggered event for `item`, to run an action on directly. */
export function firedOn<I extends Item>(item: I, event = "trigger"): TriggeredEvent<I> {
  return {
    item,
    answers: {},
    model: "jev-test",
    latencyMs: 5,
    usage: { inputTokens: 100, outputTokens: 0 },
    cached: false,
    dryRun: false,
    protected: false,
    trigger: { event, question: event, probability: 0.95 },
  };
}
