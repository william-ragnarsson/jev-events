import {
  connectionInfo,
  toConnection,
  type ActionContext,
  type App,
  type Connection,
  type Credentials,
  type Item,
  type JsonValue,
  type Source,
  type TriggeredEvent,
} from "jev-events";

import type { FakeGoogle } from "./fake-google.js";

/** Wait until `condition` holds, polling every few milliseconds. */
export async function waitFor(condition: () => boolean, ms = 2_000, what = "the condition"): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error(`Waited ${ms}ms for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The fake's signed-in account as a saved connection. */
export function connectionTo(google: FakeGoogle): Connection {
  return toConnection("google", google.connection());
}

export interface CheckerOptions {
  /** Default: the fake's account, when `google` is given. */
  connection?: Connection;
  app?: App;
}

export interface Checker<I extends Item, S> {
  /** Open the session the first time, then run one check the way the runtime does. */
  check(): Promise<void>;
  /** The session, opened once and reused, as the runtime does within one run. */
  session(): Promise<S>;
  /** What an action gets when it runs on this connection's items. */
  actionContext(): Promise<ActionContext<S>>;
  readonly items: I[];
  /** Problems reported with `ctx.fail()`. Errors a check throws reject `check()` instead. */
  readonly errors: Array<{ error: unknown; fatal: boolean }>;
  readonly warnings: string[];
  /** Credentials saved with `saveCredentials()`, in order. */
  readonly saved: Credentials[];
  /** Where the last check left off. */
  readonly cursor: JsonValue | undefined;
  /** Stop, as when the run is stopped. */
  abort(): void;
}

/**
 * Run a source's checks without a monitor, collecting what it emits, reports and logs. The cursor
 * lives in memory, so consecutive checks carry on where the last one left off.
 */
export function checker<I extends Item, P extends string, S>(source: Source<I, P, S>, options: CheckerOptions = {}): Checker<I, S> {
  const controller = new AbortController();
  const items: I[] = [];
  const errors: Array<{ error: unknown; fatal: boolean }> = [];
  const warnings: string[] = [];
  const saved: Credentials[] = [];
  let connection = options.connection;
  let cursor: JsonValue | undefined;
  let opened: Promise<S> | undefined;
  const note = (message: string, ...args: unknown[]) => void warnings.push([message, ...args].map(String).join(" "));
  const log = { debug: () => {}, info: () => {}, warn: note, error: note };

  const session = () =>
    (opened ??= Promise.resolve().then(() => {
      if (!source.session) throw new Error(`${source.id} has no session().`);
      return source.session({
        connection,
        app: options.app,
        log,
        signal: controller.signal,
        saveCredentials: async (credentials) => {
          saved.push(credentials);
          if (connection) connection = { ...connection, credentials };
        },
      });
    }));

  return {
    items,
    errors,
    warnings,
    saved,
    get cursor() {
      return cursor;
    },
    session,
    async check() {
      if (!source.check) throw new Error(`${source.id} has no check().`);
      const current = await session();
      await source.check({
        emit: async (item) => void items.push(item),
        signal: controller.signal,
        log,
        fail: (error, failOptions) => void errors.push({ error, fatal: failOptions?.fatal ?? false }),
        end: () => {},
        connection: connection ? connectionInfo(connection) : undefined,
        session: current,
        cursor: {
          get: async <T extends JsonValue = JsonValue>() => structuredClone(cursor) as T | undefined,
          set: async (value) => {
            cursor = structuredClone(value);
          },
        },
      });
    },
    async actionContext() {
      return {
        session: await session(),
        connection: connection ? connectionInfo(connection) : undefined,
        source,
        log,
        signal: controller.signal,
      };
    },
    abort: () => controller.abort(),
  };
}

/** A triggered event for `item`, to run an action on directly. */
export function firedOn<I extends Item>(item: I, event = "trigger", connection?: Connection): TriggeredEvent<I> {
  return {
    item,
    answers: {},
    connection: connection ? connectionInfo(connection) : undefined,
    monitor: "test",
    model: "jev-test",
    latencyMs: 5,
    usage: { inputTokens: 100, outputTokens: 0 },
    cached: false,
    dryRun: false,
    protected: false,
    trigger: { event, question: event, probability: 0.95 },
  };
}
