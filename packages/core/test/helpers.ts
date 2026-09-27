import { toConnection, type Connection, type ConnectedSource, type Item, type Source, type SourceContext } from "../src/index.js";

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
      void context.emit(item);
      return item;
    },
    end() {
      context?.end();
    },
  };
}

export interface InboxSource extends ConnectedSource<Item, "test"> {
  /** Put an item in a connection's inbox. The next check reads it. */
  deliver(connectionId: string, text: string, extra?: Partial<Item>): Item;
  /** The connection ids checked, in order. */
  readonly checks: string[];
}

/**
 * A polling source that reads one inbox per connection, like an email integration. Its cursor
 * is how many items of the inbox it has read.
 */
export function inboxSource(overrides: Partial<Omit<Source<Item, "test">, "integration">> = {}): InboxSource {
  const inboxes = new Map<string, Item[]>();
  const checks: string[] = [];
  return {
    id: "test:inbox",
    platform: "test",
    noun: "email",
    integration: "test",
    async check(ctx) {
      const id = ctx.connection?.id ?? "-";
      checks.push(id);
      const inbox = inboxes.get(id) ?? [];
      const from = (await ctx.cursor.get<number>()) ?? 0;
      for (const item of inbox.slice(from)) await ctx.emit(item);
      await ctx.cursor.set(inbox.length);
    },
    ...overrides,
    checks,
    deliver(connectionId, text, extra = {}) {
      let inbox = inboxes.get(connectionId);
      if (!inbox) inboxes.set(connectionId, (inbox = []));
      const item: Item = { id: `e${++counter}`, text, at: new Date(), ...extra };
      inbox.push(item);
      return item;
    },
  };
}

/** A connection of the "test" integration, as if `account` signed in. */
export function testConnection(account: string, extra: Partial<Connection> = {}): Connection {
  return { ...toConnection("test", { account, credentials: { token: `token-${account}` } }), ...extra };
}

/** Let queued promise callbacks run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}
