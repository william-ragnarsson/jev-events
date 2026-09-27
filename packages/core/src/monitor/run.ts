import type { EntryType, JsonValue, Question, Questions, ResultFor, SystemOneResult } from "@typesafe-ai/sdk";

import { isAction } from "../action.js";
import { connectionInfo, needsSignIn, type App, type Connection, type ConnectionInfo, type Credentials } from "../connection.js";
import type { Logger } from "../logger.js";
import { evaluate, type OutcomeSpec } from "../policy.js";
import type { Limiter, Lane, Scheduler } from "../runtime/scheduler.js";
import type { Percentiles } from "../scheduler.js";
import { buildState } from "../state.js";
import { storeKey, type Store } from "../store/types.js";
import type {
  Action,
  ActionStatus,
  AnySource,
  Cursor,
  DropReason,
  ErrorPhase,
  HandlerFn,
  Item,
  JevClient,
  JudgedEvent,
  SourceContext,
  SpecialEventMap,
  SpecialEventName,
  TriggeredEvent,
} from "../types.js";
import type { Budget } from "./budget.js";
import { TextCache } from "./cache.js";
import { isThenable, summarize } from "./checks.js";

/** How long an item id counts as seen, so a source that reads it again doesn't judge it twice. */
const SEEN_MS = 3 * 86_400_000;
/** How long a native action counts as done for an item. */
const ACTION_MS = 30 * 86_400_000;
/** How often the profile is read again while a run is busy. */
const PROFILE_MS = 5 * 60_000;
/** Item ids a live stream remembers to drop repeats. */
const SEEN_IN_MEMORY = 2000;
const NO_ITEMS: readonly never[] = Object.freeze([]);

/**
 * How a run gets items: a live `stream` (source.start), a `check` for what's new since the
 * cursor (source.check), or a `push` the platform posted to the webhook route (source.receive).
 */
export type RunMode = "stream" | "check" | "push";

/** How a monitor reads its source when it runs as a worker: a live stream, else checks, else pushes. */
export function deliveryOf(source: AnySource): RunMode {
  if (source.start) return "stream";
  if (source.check) return "check";
  return "push";
}

export interface Registration extends OutcomeSpec {
  handler: HandlerFn<Item, Questions> | Action<string, Item>;
  name: string;
}

export interface Counters {
  received: number;
  judged: number;
  cached: number;
  errors: number;
  dropped: Record<DropReason, number>;
  actions: Record<ActionStatus, number>;
  usage: { inputTokens: number; outputTokens: number };
}

type Protection = { protected: boolean; protectedBecause?: string };
type AnyEvent = SpecialEventMap<Item, Questions>;

/** What a run needs from its monitor. `JevMonitor` implements it. */
export interface MonitorCore {
  readonly id: string;
  readonly source: AnySource;
  readonly questions: Questions;
  /** The questions as sent to Jev, pointed at the item when there is context. */
  readonly ask: Questions;
  readonly log: Logger;
  readonly now: () => number;
  readonly dryRun: boolean;
  readonly recent: number;
  readonly about: JsonValue | undefined;
  readonly maxQueue: number;
  readonly maxLagMs: number;
  readonly model: string | undefined;
  readonly timeoutMs: number | undefined;
  readonly cache: { ttlMs: number; max: number } | undefined;
  readonly outcomes: readonly Registration[];
  readonly counters: Counters;
  readonly latency: Percentiles;
  readonly runs: Set<Run>;
  readonly profiled: boolean;
  readonly filter: ((item: Item) => boolean) | undefined;
  readonly protect: ((item: Item, connection: ConnectionInfo | undefined) => boolean | string | Promise<boolean | string>) | undefined;
  readonly state:
    | ((
        item: Item,
        context: { recent: readonly Item[]; about: JsonValue | undefined; profile: JsonValue | undefined; connection: ConnectionInfo | undefined },
      ) => EntryType)
    | undefined;
  client(): JevClient;
  profileOf(connection: ConnectionInfo | undefined): Promise<JsonValue | undefined>;
  budgetFor(connection: ConnectionInfo | undefined, store: Store): Promise<Budget | undefined>;
  emit<E extends SpecialEventName>(name: E, payload: AnyEvent[E], run?: Run): void;
}

/** What a run needs from the runtime it belongs to. */
export interface RunHost {
  readonly store: Store;
  readonly scheduler: Scheduler;
  app(integration: string | undefined): App | undefined;
  /** A run stopped because of a fatal error. `restart` is false when the user has to sign in again. */
  failed(run: Run, error: unknown, restart: boolean): void;
}

interface Job {
  item: Item;
  recent: readonly Item[];
  receivedAt: number;
}

interface Judgment {
  result: SystemOneResult<Questions>;
  latencyMs: number;
}

/**
 * One monitor reading one connection, or its fixed stream. Runs are isolated from each other:
 * a failing connection stops only its own run, and each run has its own queue, history, cache,
 * session and cursor. They share the runtime's request limits through the scheduler.
 */
export class Run implements Lane {
  readonly core: MonitorCore;
  readonly host: RunHost;
  readonly mode: RunMode;
  readonly info: ConnectionInfo | undefined;
  /** The connection id, or "-" for a fixed stream. */
  readonly key: string;
  readonly limiter: Limiter | undefined;
  readonly controller = new AbortController();
  status: "new" | "opening" | "active" | "stopped" = "new";
  /** The error that stopped the run, if one did. */
  failure: unknown;

  readonly #connection: Connection | undefined;
  #credentials: Credentials | undefined;
  #opening: Promise<void> | undefined;
  #session: unknown;
  #profile: JsonValue | undefined;
  #profileAt = 0;
  #profileRefresh: Promise<void> | undefined;
  #budget: Budget | undefined;
  readonly #cache: TextCache<Judgment> | undefined;
  readonly #cursor: Cursor;
  readonly #queue: Job[] = [];
  readonly #history: Item[] = [];
  readonly #seen = new Set<string>();
  #inflight = 0;
  readonly #pending = new Set<Promise<unknown>>();
  readonly #idleWaiters: Array<() => void> = [];
  readonly #endWaiters: Array<() => void> = [];
  #ended = false;
  #stopping: Promise<void> | undefined;

  constructor(core: MonitorCore, host: RunHost, connection: Connection | undefined, mode: RunMode, limiter: Limiter | undefined) {
    this.core = core;
    this.host = host;
    this.mode = mode;
    this.limiter = limiter;
    this.#connection = connection;
    this.#credentials = connection?.credentials;
    this.info = connection ? connectionInfo(connection) : undefined;
    this.key = connection?.id ?? "-";
    this.#cache = core.cache ? new TextCache(core.cache.ttlMs, core.cache.max, core.now) : undefined;
    const cursorKey = storeKey("cursor", core.id, this.key);
    this.#cursor = {
      get: async <T extends JsonValue = JsonValue>() => (await host.store.get(cursorKey)) as T | undefined,
      set: (value) => host.store.set(cursorKey, value),
    };
    core.runs.add(this);
  }

  /** What `source.session()` returned, such as an API client. */
  get session(): unknown {
    return this.#session;
  }

  /** The newest tokens this run knows of, including ones it refreshed itself. */
  get credentials(): Credentials | undefined {
    return this.#credentials;
  }

  get inflight(): number {
    return this.#inflight;
  }

  get queued(): number {
    return this.#queue.length;
  }

  get isIdle(): boolean {
    return this.#queue.length === 0 && this.#inflight === 0 && this.#pending.size === 0;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Build the session, read the profile and budget, and start taking request slots. */
  open(): Promise<void> {
    if (this.status === "active") return Promise.resolve();
    if (this.status === "stopped") return Promise.reject(new Error(`The run of ${this.core.id} for ${this.key} was stopped.`));
    this.#opening ??= this.#open().catch((error: unknown) => {
      this.#opening = undefined;
      if (this.status === "opening") this.status = "new";
      throw error;
    });
    return this.#opening;
  }

  async #open(): Promise<void> {
    this.status = "opening";
    const { core, host } = this;
    const connection = this.#connection;
    this.#session = await core.source.session?.({
      connection: connection ? { ...connection, credentials: this.#credentials ?? connection.credentials } : undefined,
      app: host.app(core.source.integration),
      log: core.log,
      signal: this.controller.signal,
      saveCredentials: (credentials) => this.#saveCredentials(credentials),
    });
    this.#profile = await core.profileOf(this.info);
    this.#profileAt = core.now();
    this.#budget = await core.budgetFor(this.info, host.store);
    if (this.status !== "opening") return;
    this.status = "active";
    host.scheduler.add(this);
    host.scheduler.pump();
  }

  /** Connect a live stream. Resolves once the source is connected. */
  async start(): Promise<void> {
    await this.open();
    if (this.status !== "active") return;
    await this.core.source.start?.(this.#context());
  }

  /** Ask the source for what's new. Resolves false when that failed; the error is reported. */
  async check(): Promise<boolean> {
    try {
      await this.open();
      if (this.status !== "active") return false;
      await this.core.source.check?.(this.#context());
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  /** Report a source problem. Fatal ones, and ones that need a new sign-in, stop the run. */
  fail(error: unknown, options: { fatal?: boolean } = {}): void {
    if (this.status === "stopped") return;
    const signIn = needsSignIn(error);
    const fatal = signIn || (options.fatal ?? false);
    this.#error(error, "source", undefined, { ...(fatal ? { fatal } : {}), ...(signIn ? { needsSignIn: true } : {}) });
    if (!fatal) return;
    this.failure = error;
    // Tracked, so stopping waits until the connection is marked.
    const restart = signIn ? this.#markSignIn(error) : Promise.resolve(true);
    this.#track(restart.then((again) => this.host.failed(this, error, again)));
    void this.stop();
  }

  /** Finite sources call this after their last item. */
  end(): void {
    this.#ended = true;
    flush(this.#endWaiters);
    this.#checkIdle();
  }

  /** Resolves when the source ended or the run stopped. */
  ended(): Promise<void> {
    if (this.#ended) return Promise.resolve();
    return new Promise((resolve) => this.#endWaiters.push(resolve));
  }

  /** Resolves when nothing is queued, in flight or being handled. */
  idle(): Promise<void> {
    if (this.isIdle) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /** Stop reading, drop what's still queued, and wait for requests and handlers in flight. */
  stop(): Promise<void> {
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    this.status = "stopped";
    this.controller.abort();
    this.host.scheduler.remove(this);
    for (const job of this.#queue.splice(0)) {
      this.#drop(job.item, "stopped");
      // Let a later check read it again if its cursor didn't move past it.
      if (this.mode !== "stream") this.#track(this.host.store.delete(this.#seenKey(job.item)));
    }
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
    this.#ended = true;
    flush(this.#endWaiters);
    flush(this.#idleWaiters);
    this.core.runs.delete(this);
  }

  /** Keep the run busy until `promise` settles, such as an async event handler. */
  track(promise: Promise<unknown>): void {
    this.#track(promise);
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  /** Take an item from the source. Items already seen for this connection are dropped. */
  receive(item: Item): Promise<void> {
    if (this.status === "stopped") return Promise.resolve();
    this.core.counters.received++;
    if (this.mode === "stream") {
      if (this.#seen.has(item.id)) {
        this.#drop(item, "duplicate");
      } else {
        this.#seen.add(item.id);
        if (this.#seen.size > SEEN_IN_MEMORY) this.#seen.delete(this.#seen.values().next().value as string);
        this.#accept(item);
      }
      return Promise.resolve();
    }
    // Checks and pushes can run in several processes, so "seen" lives in the store.
    const claimed = this.host.store.claim(this.#seenKey(item), { ttlMs: SEEN_MS }).then(
      (fresh) => (fresh ? this.#accept(item) : this.#drop(item, "duplicate")),
      (error: unknown) => {
        this.#error(error, "source", item);
        this.#accept(item);
      },
    );
    this.#track(claimed);
    return claimed;
  }

  #accept(item: Item): void {
    if (this.status === "stopped") return this.#drop(item, "stopped");
    const { core } = this;
    const recent = core.recent > 0 ? this.#history.slice(-core.recent) : NO_ITEMS;
    if (core.recent > 0) {
      this.#history.push(item);
      if (this.#history.length > core.recent) this.#history.shift();
    }

    if (core.filter) {
      let keep: boolean;
      try {
        keep = core.filter(item);
      } catch (error) {
        this.#error(error, "handler", item);
        keep = false;
      }
      if (!keep) return this.#drop(item, "filtered");
    }
    if (this.#budget?.exhausted) return this.#drop(item, "budget");

    const hit = this.#cache?.get(item.text);
    if (hit) return this.#follow(item, hit);

    this.#queue.push({ item, recent, receivedAt: core.now() });
    if (this.#queue.length > core.maxQueue) {
      const oldest = this.#queue.shift();
      if (oldest) this.#drop(oldest.item, "overflow");
    }
    if (this.status === "active") this.host.scheduler.pump();
  }

  /** Lane: drop items that can't be judged any more, and say whether one is waiting. */
  ready(): boolean {
    if (this.status !== "active") return false;
    const { core } = this;
    while (this.#queue.length > 0) {
      const job = this.#queue[0] as Job;
      if (core.now() - job.receivedAt > core.maxLagMs) {
        this.#queue.shift();
        this.#drop(job.item, "stale");
      } else if (this.#budget?.exhausted) {
        this.#queue.shift();
        this.#drop(job.item, "budget");
      } else {
        return true;
      }
    }
    this.#checkIdle();
    return false;
  }

  /** Lane: judge the front item. */
  begin(done: () => void): void {
    const job = this.#queue.shift();
    if (!job) return done();
    this.#inflight++;
    const { core } = this;
    const request = (async (): Promise<Judgment> => {
      const client = core.client();
      const state = this.#state(job);
      this.#refreshProfile();
      const started = core.now();
      const result = await client.systemOne(
        { state, questions: core.ask, ...(core.model ? { model: core.model } : {}) },
        { signal: this.controller.signal, ...(core.timeoutMs ? { timeout: core.timeoutMs } : {}) },
      );
      return { result, latencyMs: core.now() - started };
    })();
    this.#cache?.set(job.item.text, request);

    const settle = () => {
      this.#inflight--;
      done();
    };
    this.#track(
      request.then(
        ({ result, latencyMs }) => {
          core.latency.add(latencyMs);
          core.counters.usage.inputTokens += result.usage.input_tokens;
          core.counters.usage.outputTokens += result.usage.output_tokens;
          // Count the tokens before the slot frees up, so the next item sees the new total.
          this.#spend(result.usage.input_tokens);
          settle();
          return this.#deliver(job.item, result, latencyMs, false);
        },
        (error: unknown) => {
          settle();
          this.#judgeFailed(job.item, error);
        },
      ),
    );
  }

  #follow(item: Item, request: Promise<Judgment>): void {
    this.#track(
      request.then(
        ({ result }) => {
          this.core.counters.cached++;
          return this.#deliver(item, result, 0, true);
        },
        (error: unknown) => this.#judgeFailed(item, error),
      ),
    );
  }

  #spend(tokens: number): void {
    const saved = this.#budget?.spend(tokens);
    if (saved) {
      this.#track(Promise.resolve(saved).catch((error: unknown) => this.core.log.warn("couldn't save today's token count:", error)));
    }
  }

  #state(job: Job): EntryType {
    const { core } = this;
    if (core.state) {
      return core.state(job.item, { recent: job.recent, about: core.about, profile: this.#profile, connection: this.info });
    }
    return buildState(core.source, { item: job.item, recent: job.recent, about: core.about, profile: this.#profile });
  }

  #refreshProfile(): void {
    const { core } = this;
    if (!core.profiled || this.#profileRefresh || core.now() - this.#profileAt < PROFILE_MS) return;
    this.#profileRefresh = core
      .profileOf(this.info)
      .then(
        (profile) => {
          this.#profile = profile;
        },
        // Keep judging with the profile we have.
        (error: unknown) => this.#error(error, "handler"),
      )
      .finally(() => {
        this.#profileAt = core.now();
        this.#profileRefresh = undefined;
      });
    this.#track(this.#profileRefresh);
  }

  #judgeFailed(item: Item, error: unknown): void {
    if (this.status === "stopped") return;
    this.#error(error, "judge", item);
  }

  // -------------------------------------------------------------------------
  // Outcomes
  // -------------------------------------------------------------------------

  #deliver(item: Item, result: SystemOneResult<Questions>, latencyMs: number, cached: boolean): void | Promise<void> {
    if (this.status === "stopped") return;
    this.core.counters.judged++;
    const protection = this.#protection(item);
    if (isThenable(protection)) return protection.then((p) => this.#judged(item, result, latencyMs, cached, p));
    this.#judged(item, result, latencyMs, cached, protection);
  }

  #judged(item: Item, result: SystemOneResult<Questions>, latencyMs: number, cached: boolean, protection: Protection): void {
    const { core } = this;
    const event: JudgedEvent = {
      item,
      answers: result.answers,
      connection: this.info,
      monitor: core.id,
      model: result.model,
      latencyMs,
      usage: cached
        ? { inputTokens: 0, outputTokens: 0 }
        : { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens },
      cached,
      dryRun: core.dryRun,
      ...protection,
    };
    core.emit("judged", event, this);

    for (const registration of core.outcomes) {
      const question = core.questions[registration.question] as Question;
      const answer = event.answers[registration.question] as ResultFor<Question> | undefined;
      if (!answer) continue;
      const verdict = evaluate(registration, question, answer);
      if (!verdict) continue;
      const triggered: TriggeredEvent = { ...event, trigger: verdict.trigger };
      if (verdict.kind === "review") {
        core.emit("review", { ...triggered, handler: registration.name }, this);
      } else {
        this.#track(this.#runHandler(registration, triggered));
      }
    }
  }

  /** The source says who's protected first, then the monitor's `protect`. Unknown means protected. */
  #protection(item: Item): Protection | Promise<Protection> {
    const { core } = this;
    const unsure: Protection = { protected: true, protectedBecause: "couldn't check whether the item is protected" };
    const toProtection = (verdict: boolean | string | undefined): Protection =>
      typeof verdict === "string" && verdict ? { protected: true, protectedBecause: verdict } : { protected: Boolean(verdict) };
    const orMonitor = (verdict: boolean | string | undefined) => verdict || core.protect?.(item, this.info);
    try {
      const first = core.source.isProtected?.(item, { connection: this.info, session: this.#session });
      if (isThenable(first)) return Promise.resolve(first).then(orMonitor).then(toProtection, () => unsure);
      const second = orMonitor(first);
      if (isThenable(second)) return Promise.resolve(second).then(toProtection, () => unsure);
      return toProtection(second);
    } catch {
      return unsure;
    }
  }

  async #runHandler(registration: Registration, event: TriggeredEvent): Promise<void> {
    const { handler } = registration;
    if (isAction(handler)) return this.#runAction(handler, event);
    try {
      await handler(event);
    } catch (error) {
      this.#error(error, "handler", event.item);
    }
  }

  async #runAction(action: Action<string, Item>, event: TriggeredEvent): Promise<void> {
    const { core } = this;
    let description: string;
    try {
      description = action.describe(event);
    } catch {
      description = action.name;
    }
    const report = (status: ActionStatus, reason?: string) => {
      core.counters.actions[status]++;
      core.emit("action", { action: action.name, description, status, ...(reason ? { reason } : {}), event }, this);
    };

    if (event.protected) return report("skipped", event.protectedBecause ?? "protected user");
    if (event.dryRun) {
      core.log.info(`[dry-run] would ${description} (${summarize(event.trigger)})`);
      return report("dry-run");
    }
    if (core.source.canAct === false) return report("skipped", `${core.source.id} isn't authenticated`);

    let first: boolean;
    try {
      first = await this.host.store.claim(storeKey("action", core.id, this.key, event.item.id, action.name), { ttlMs: ACTION_MS });
    } catch (error) {
      report("failed", `couldn't record the action: ${message(error)}`);
      this.#error(error, "action", event.item);
      return;
    }
    if (!first) return report("skipped", "already ran for this item");

    try {
      await action.run(event, {
        session: this.#session,
        connection: this.info,
        source: core.source,
        log: core.log,
        signal: this.controller.signal,
      });
      report("done");
    } catch (error) {
      report("failed", message(error));
      this.#error(error, "action", event.item);
    }
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  #context(): SourceContext {
    return {
      emit: (item) => this.receive(item),
      signal: this.controller.signal,
      log: this.core.log,
      fail: (error, options) => this.fail(error, options),
      end: () => this.end(),
      connection: this.info,
      session: this.#session,
      cursor: this.#cursor,
    };
  }

  async #saveCredentials(credentials: Credentials): Promise<void> {
    this.#credentials = credentials;
    if (this.#connection) await this.host.store.connections.update(this.#connection.id, { credentials });
  }

  /**
   * Mark the connection "needs-sign-in", unless the user signed in again since this run started.
   * Resolves whether the run should start again.
   */
  async #markSignIn(error: unknown): Promise<boolean> {
    const connection = this.#connection;
    if (!connection) return false;
    try {
      const saved = await this.host.store.connections.get(connection.id);
      if (!saved) return false;
      if (JSON.stringify(saved.credentials) !== JSON.stringify(this.#credentials)) return true;
      await this.host.store.connections.update(connection.id, { status: "needs-sign-in", problem: message(error) });
    } catch (storeError) {
      this.core.log.warn(`couldn't mark ${connection.label ?? connection.id} as needing a new sign-in:`, storeError);
    }
    return false;
  }

  #seenKey(item: Item): string {
    return storeKey("seen", this.core.id, this.key, item.id);
  }

  #error(error: unknown, phase: ErrorPhase, item?: Item, extra: { fatal?: boolean; needsSignIn?: boolean } = {}): void {
    this.core.counters.errors++;
    this.core.emit(
      "error",
      { error, phase, monitor: this.core.id, ...(item ? { item } : {}), ...(this.info ? { connection: this.info } : {}), ...extra },
      this,
    );
  }

  #drop(item: Item, reason: DropReason): void {
    this.core.counters.dropped[reason]++;
    this.core.emit("dropped", { item, reason, connection: this.info, monitor: this.core.id }, this);
  }

  #track(promise: Promise<unknown>): void {
    const tracked: Promise<unknown> = promise
      .catch((error: unknown) => this.core.log.error("unexpected error:", error))
      .finally(() => {
        this.#pending.delete(tracked);
        this.#checkIdle();
      });
    this.#pending.add(tracked);
  }

  #checkIdle(): void {
    if (this.isIdle) flush(this.#idleWaiters);
  }
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function flush(waiters: Array<() => void>): void {
  for (const resolve of waiters.splice(0)) resolve();
}
