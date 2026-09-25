import type { Item, Source, SourceContext } from "../src/index.js";

export interface ManualSource<P extends string = "test"> extends Source<Item, P> {
  push(text: string, extra?: Partial<Item>): Item;
  end(): void;
  readonly context: SourceContext<Item> | undefined;
}

let counter = 0;

/** A source driven by the test: push items, end the stream. */
export function manualSource<P extends string = "test">(
  overrides: Partial<Omit<Source<Item, P>, "start">> & { platform?: P } = {},
): ManualSource<P> {
  let context: SourceContext<Item> | undefined;
  return {
    id: "test:manual",
    platform: "test" as P,
    noun: "message",
    ...overrides,
    get context() {
      return context;
    },
    start(ctx) {
      context = ctx;
    },
    push(text, extra = {}) {
      if (!context) throw new Error("source not started");
      const item: Item = { id: `m${++counter}`, text, at: new Date(), ...extra };
      context.emit(item);
      return item;
    },
    end() {
      context?.end();
    },
  };
}

/** Let queued promise callbacks run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}
