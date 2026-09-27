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

import { BOT, type FakeTwitch } from "./fake-twitch.js";

/** Wait until `condition` holds, polling every few milliseconds. */
export async function waitFor(condition: () => boolean, ms = 2_000, what = "the condition"): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error(`Waited ${ms}ms for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An account on the fake Twitch as a saved connection. Default: the bot, which moderates for the streamer. */
export function connectionTo(
  twitch: FakeTwitch,
  user: { id: string; login: string } = BOT,
  options: Parameters<FakeTwitch["connection"]>[1] = {},
): Connection {
  return toConnection("twitch", twitch.connection(user, options));
}

export interface StreamerOptions {
  /** Default: none, so the session says a connection is needed. */
  connection?: Connection;
  app?: App;
}

export interface Streamer<I extends Item, S> {
  /** Open the session the first time, then start the source the way a run does. Settles when `source.start()` does. */
  start(): Promise<void>;
  /** The session, opened once and reused, as the runtime does within one run. */
  session(): Promise<S>;
  /** What an action gets when it runs on this connection's items. */
  actionContext(): Promise<ActionContext<S>>;
  readonly items: I[];
  /** Problems reported with `ctx.fail()`. A fatal one stops the run, as the runtime does. */
  readonly errors: Array<{ error: unknown; fatal: boolean }>;
  readonly warnings: string[];
  readonly infos: string[];
  /** Credentials the session saved, such as renewed tokens, newest last. */
  readonly saved: Credentials[];
  /** True once the source called `ctx.end()`. */
  readonly ended: boolean;
  readonly signal: AbortSignal;
  stop(): void;
}

const running = new Set<{ stop(): void }>();

/** Stop everything started in the test, so no EventSub connection outlives its fake Twitch. */
export function stopAll(): void {
  for (const streamer of running) streamer.stop();
  running.clear();
}

/** Run a stream source without a monitor, collecting what it emits, reports, logs and saves. */
export function streamer<I extends Item, P extends string, S>(source: Source<I, P, S>, options: StreamerOptions = {}): Streamer<I, S> {
  const controller = new AbortController();
  const items: I[] = [];
  const errors: Array<{ error: unknown; fatal: boolean }> = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const saved: Credentials[] = [];
  const { connection } = options;
  let cursor: JsonValue | undefined;
  let opened: Promise<S> | undefined;
  let ended = false;
  const line = (message: string, args: unknown[]) => [message, ...args].map(String).join(" ");
  const note = (message: string, ...args: unknown[]) => void warnings.push(line(message, args));
  const log = { debug: () => {}, info: (message: string, ...args: unknown[]) => void infos.push(line(message, args)), warn: note, error: note };

  const session = () =>
    (opened ??= Promise.resolve().then(() => {
      if (!source.session) throw new Error(`${source.id} has no session().`);
      return source.session({
        connection,
        app: options.app,
        log,
        signal: controller.signal,
        saveCredentials: async (credentials) => void saved.push(structuredClone(credentials)),
      });
    }));

  const stop = () => controller.abort();
  running.add({ stop });
  return {
    items,
    errors,
    warnings,
    infos,
    saved,
    get ended() {
      return ended;
    },
    signal: controller.signal,
    session,
    async start() {
      if (!source.start) throw new Error(`${source.id} has no start().`);
      const current = await session();
      await source.start({
        emit: async (item) => void items.push(item),
        signal: controller.signal,
        log,
        fail: (error, failOptions) => {
          errors.push({ error, fatal: failOptions?.fatal ?? false });
          if (failOptions?.fatal) controller.abort();
        },
        end: () => {
          ended = true;
        },
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
      return { session: await session(), connection: connection ? connectionInfo(connection) : undefined, source, log, signal: controller.signal };
    },
    stop,
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
    trigger: { event, question: event, probability: 0.93 },
  };
}
