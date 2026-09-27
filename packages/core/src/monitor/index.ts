import { TypeSafeClient, type EntryType, type JsonValue, type Questions } from "@typesafe-ai/sdk";

import { isAction } from "../action.js";
import type { App, Connection, ConnectionInfo } from "../connection.js";
import { toMs, type Duration } from "../duration.js";
import { createLogger, type Logger, type LogLevel } from "../logger.js";
import { estimateCostUsd, JEV_USD_PER_MILLION_INPUT_TOKENS } from "../pricing.js";
import { JevRuntime } from "../runtime/index.js";
import { Limiter, type RateOptions } from "../runtime/scheduler.js";
import { DailyBudget, Percentiles } from "../scheduler.js";
import { inspectQuestions } from "../state.js";
import { fileStore } from "../store/file.js";
import { memoryStore } from "../store/memory.js";
import type { Store } from "../store/types.js";
import type {
  ActionEvent,
  AnySource,
  ConnectionOf,
  ErrorEvent,
  Item,
  ItemOf,
  JevClient,
  MonitorStats,
  OutcomeEventName,
  OutcomeHandler,
  PolicyFor,
  ProbabilityPolicy,
  ScorePolicy,
  SpecialEventMap,
  SpecialEventName,
} from "../types.js";
import { allOf, sharedBudget, StoredBudget, type Budget } from "./budget.js";
import { checkPolicy, checkQuestions, eventNames, isThenable, SPECIAL } from "./checks.js";
import { deliveryOf, type Counters, type MonitorCore, type Registration, type Run } from "./run.js";

export interface MonitorOptions<S extends AnySource, Q extends Questions> {
  /** What to read, such as `google.gmail.inbox()` or `twitch.chat("mychannel")`. */
  source: S;
  /** What Jev answers about every item. Each answer becomes an event you can handle with `on()`. */
  questions: Q;
  /** Names the monitor in stats, logs and saved state. Defaults to the source's id. Keep it stable. */
  id?: string;
  /** How often a polling source checks for new items. Defaults to the source's suggestion, or one minute. */
  every?: Duration;
  /** The Jev client. Defaults to `new TypeSafeClient()`, which reads `TYPESAFE_API_KEY`. */
  client?: JevClient;
  /** Model override, such as "jev-1.13.0". Defaults to the client's default. */
  model?: string;
  /** Native actions only log what they would do. Default true. Set false to let them act. */
  dryRun?: boolean;
  /**
   * What your product knows about the person behind a connection, such as their role or who
   * matters to them. Jev reads it as context. Read again every few minutes while items arrive.
   */
  profile?: (connection: ConnectionOf<S>) => JsonValue | undefined | Promise<JsonValue | undefined>;
  /** Return false to skip an item before it is judged, so it costs nothing. */
  filter?: (item: ItemOf<S>) => boolean;
  /**
   * Items native actions must never touch, on top of what the source protects. Return a string
   * to say why, such as "a customer".
   */
  protect?: (item: ItemOf<S>, connection: ConnectionOf<S>) => boolean | string | Promise<boolean | string>;
  context?: {
    /** How many preceding items Jev sees. Defaults to the source's suggestion. */
    recent?: number;
    /** Facts about the stream that don't change, such as channel rules. */
    about?: JsonValue;
  };
  /** Build what Jev sees yourself instead of using the source's default view. */
  state?: (
    item: ItemOf<S>,
    context: {
      recent: readonly ItemOf<S>[];
      about: JsonValue | undefined;
      profile: JsonValue | undefined;
      connection: ConnectionOf<S>;
    },
  ) => EntryType;
  /**
   * Point questions at this key of what Jev sees. Defaults to the source's noun whenever there is
   * context, so context is read as context. `false` sends the questions unchanged.
   */
  inspect?: string | false;
  /** This monitor's share of requests, on top of the runtime's limit. */
  rate?: RateOptions;
  /** Items waiting per connection. The oldest are dropped beyond this. Default 1000. */
  maxQueue?: number;
  /** Drop items that waited longer than this for a request. Defaults to the source's suggestion. */
  maxLagMs?: number;
  /** Reuse answers for the same text (copy-paste floods) for `ttlMs`, per connection. Default off. */
  cache?: boolean | { ttlMs?: number; max?: number };
  /**
   * Stop judging once this many input tokens were spent in the current UTC day, in total and per
   * connection. Counted in the store, so every process shares it. Pass a `DailyBudget` instead to
   * share one in-process budget between monitors.
   */
  budget?: DailyBudget | { inputTokensPerDay?: number; perConnection?: { inputTokensPerDay?: number } };
  /** Timeout per Jev request attempt, in milliseconds. */
  timeoutMs?: number;
  log?: Logger | LogLevel;
  pricing?: { usdPerMillionInputTokens?: number };
  /** Clock override for tests. */
  now?: () => number;
}

/** Where a monitor started on its own keeps its state, and which accounts it reads. */
export interface StartOptions {
  /**
   * Cursors, "already seen" marks, budgets and connections. Defaults to the `.jev-events` folder
   * (where `npx jev-events auth` saves sign-ins) for sources that read accounts, else memory.
   */
  store?: Store;
  /** Accounts to read, such as ones built with `toConnection()` from tokens you already have. */
  connections?: readonly Connection[];
  /** Your OAuth apps, so sources can refresh tokens. */
  apps?: readonly App[];
}

export interface Monitor<S extends AnySource = AnySource, Q extends Questions = Questions> {
  readonly id: string;
  readonly source: S;
  readonly questions: Q;
  /** Observe every judgment, review, action, drop or error. */
  on<E extends SpecialEventName>(event: E, handler: (event: SpecialEventMap<ItemOf<S>, Q, ConnectionOf<S>>[E]) => unknown): this;
  /** Run a handler or native action when an outcome fires. */
  on<E extends OutcomeEventName<Q>>(event: E, handler: OutcomeHandler<S, Q>): this;
  /** Run a handler or native action when an outcome fires under a policy such as `{ min: 0.85 }`. */
  on<E extends OutcomeEventName<Q>>(event: E, policy: PolicyFor<Q, E>, handler: OutcomeHandler<S, Q>): this;
  off(event: string, handler: unknown): this;
  /** Attach a plugin such as `logTo("audit.jsonl")`. A function it returns runs on stop. */
  use(plugin: Plugin<S, Q>): this;
  /**
   * Run on its own, in this process, until `stop()`: connect live streams, and check polling
   * sources every `every`. For web apps, pass monitors to `runtime()` instead.
   */
  start(options?: StartOptions): Promise<void>;
  /** Disconnect, drop what's still queued, and wait for requests and handlers in flight. */
  stop(): Promise<void>;
  /** Resolves when nothing is queued, in flight or being handled. */
  idle(): Promise<void>;
  /**
   * Read once and finish: check every account once (or read a finite source to its end), handle
   * every item, stop, and return the stats. Good for scripts and cron jobs.
   */
  run(options?: StartOptions): Promise<MonitorStats>;
  stats(): MonitorStats;
}

export type Plugin<S extends AnySource = AnySource, Q extends Questions = Questions> = (
  monitor: Monitor<S, Q>,
) => void | (() => unknown);

/**
 * Ask Jev the same questions about every item a source produces, and act on the answers.
 *
 * @example
 * ```ts
 * const invites = monitor({
 *   source: google.calendar.invites(),
 *   questions: { importance: choice("How important is this invite to them?", { critical: null, normal: null, low: null }) },
 *   profile: (connection) => profileOf(connection.userId),
 * });
 * invites.on("importance:critical", { min: 0.85, review: 0.6 }, google.calendar.respond("accepted"));
 * invites.on("review", (e) => askUser(e.connection, e));
 * ```
 */
export function monitor<S extends AnySource, const Q extends Questions>(options: MonitorOptions<S, Q>): Monitor<S, Q> {
  return new JevMonitor(options);
}

/** The monitor behind a `Monitor`, for runtimes. */
export function coreOf(value: Monitor<any, any>): JevMonitor {
  if (!(value instanceof JevMonitor)) throw new TypeError("Pass monitors created with monitor().");
  return value as JevMonitor;
}

type AnyHandler = (event: never) => unknown;
type AnyEvent = SpecialEventMap<Item, Questions>;

const RESTART = "A stopped monitor can't be restarted. Create a new one with monitor().";

export class JevMonitor<S extends AnySource = AnySource, Q extends Questions = Questions> implements Monitor<S, Q>, MonitorCore {
  readonly id: string;
  readonly source: S;
  readonly questions: Q;
  readonly ask: Questions;
  readonly log: Logger;
  readonly now: () => number;
  readonly dryRun: boolean;
  readonly recent: number;
  readonly about: JsonValue | undefined;
  readonly maxQueue: number;
  readonly maxLagMs: number;
  readonly everyMs: number;
  readonly model: string | undefined;
  readonly timeoutMs: number | undefined;
  readonly cache: { ttlMs: number; max: number } | undefined;
  /** This monitor's own request limit, when it runs in a runtime with others. */
  readonly limiter: Limiter | undefined;
  readonly outcomes: Registration[] = [];
  readonly counters: Counters = {
    received: 0,
    judged: 0,
    cached: 0,
    errors: 0,
    dropped: { filtered: 0, duplicate: 0, stale: 0, overflow: 0, budget: 0, stopped: 0 },
    actions: { done: 0, "dry-run": 0, skipped: 0, failed: 0 },
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  readonly latency = new Percentiles();
  readonly runs = new Set<Run>();
  readonly filter: ((item: Item) => boolean) | undefined;
  readonly protect: MonitorCore["protect"];
  readonly state: MonitorCore["state"];

  readonly #options: MonitorOptions<AnySource, Questions>;
  readonly #price: number;
  readonly #special = new Map<string, Set<AnyHandler>>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #cleanups: Array<() => unknown> = [];
  readonly #connectionBudgets = new Map<string, Budget>();
  #budget: Budget | undefined;
  #client: JevClient | undefined;
  #owner: JevRuntime | undefined;
  #solo: JevRuntime | undefined;
  #status: "idle" | "running" | "stopped" = "idle";
  #stopping: Promise<void> | undefined;

  constructor(options: MonitorOptions<S, Q>) {
    const { source, questions } = options;
    if (!source || typeof source !== "object") throw new TypeError("monitor() needs a source, such as google.gmail.inbox().");
    checkQuestions(questions);
    if (!source.start && !source.check && !source.receive) {
      throw new TypeError(`${source.id} can't deliver items: it has no start(), check() or receive().`);
    }

    this.source = source;
    this.questions = questions;
    this.#options = options as unknown as MonitorOptions<AnySource, Questions>;
    this.id = options.id ?? source.id;
    this.log = typeof options.log === "object" ? options.log : createLogger(options.log ?? "info");
    this.now = options.now ?? Date.now;
    this.dryRun = options.dryRun ?? true;
    this.recent = options.context?.recent ?? source.defaults?.recent ?? 0;
    this.about = options.context?.about;
    this.maxQueue = options.maxQueue ?? 1000;
    this.maxLagMs = options.maxLagMs ?? source.defaults?.maxLagMs ?? Number.POSITIVE_INFINITY;
    this.everyMs = toMs(options.every ?? source.defaults?.every ?? 60_000);
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.limiter = options.rate ? new Limiter(options.rate, this.now) : undefined;
    this.#price = options.pricing?.usdPerMillionInputTokens ?? JEV_USD_PER_MILLION_INPUT_TOKENS;
    this.filter = options.filter as ((item: Item) => boolean) | undefined;
    this.protect = options.protect as MonitorCore["protect"];
    this.state = options.state as MonitorCore["state"];
    if (!(this.everyMs > 0)) throw new RangeError(`"every" must be more than zero, got ${String(options.every)}.`);

    const cache = options.cache;
    this.cache = cache
      ? {
          ttlMs: typeof cache === "object" ? (cache.ttlMs ?? 60_000) : 60_000,
          max: typeof cache === "object" ? (cache.max ?? 1000) : 1000,
        }
      : undefined;

    const inspectKey =
      options.inspect === false
        ? undefined
        : typeof options.inspect === "string"
          ? options.inspect
          : options.state
            ? undefined
            : this.recent > 0 || this.about !== undefined || options.profile
              ? (source.noun ?? "item")
              : undefined;
    this.ask = inspectKey ? inspectQuestions(questions, inspectKey) : questions;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  on(event: string, policyOrHandler: unknown, maybeHandler?: unknown): this {
    if (SPECIAL.has(event)) {
      if (typeof policyOrHandler !== "function") throw new TypeError(`The "${event}" handler must be a function.`);
      let handlers = this.#special.get(event);
      if (!handlers) this.#special.set(event, (handlers = new Set()));
      handlers.add(policyOrHandler as AnyHandler);
      return this;
    }
    const [policy, handler] =
      maybeHandler === undefined ? [{}, policyOrHandler] : [policyOrHandler as ProbabilityPolicy & ScorePolicy, maybeHandler];
    this.outcomes.push(this.#register(event, policy, handler));
    return this;
  }

  off(event: string, handler: unknown): this {
    if (SPECIAL.has(event)) {
      this.#special.get(event)?.delete(handler as AnyHandler);
      return this;
    }
    const index = this.outcomes.findIndex((r) => r.event === event && r.handler === handler);
    if (index !== -1) this.outcomes.splice(index, 1);
    return this;
  }

  use(plugin: Plugin<S, Q>): this {
    const cleanup = plugin(this);
    if (typeof cleanup === "function") this.#cleanups.push(cleanup);
    return this;
  }

  #register(event: string, policy: ProbabilityPolicy & ScorePolicy, handler: unknown): Registration {
    if (typeof handler !== "function" && !isAction(handler)) {
      throw new TypeError(`The handler for "${event}" must be a function or a native action.`);
    }

    const separator = event.indexOf(":");
    const questionId = separator === -1 ? event : event.slice(0, separator);
    const label = separator === -1 ? undefined : event.slice(separator + 1);
    const question = this.questions[questionId];
    const valid = () => eventNames(this.questions).join(", ");

    if (!question) throw new TypeError(`Unknown event "${event}". Valid events: ${valid()}.`);
    if (question.type === "choice") {
      if (label === undefined) {
        throw new TypeError(`"${questionId}" is a choice question; use one of its labels: ${valid()}.`);
      }
      if (!Object.hasOwn(question.criteria, label)) throw new TypeError(`Unknown event "${event}". Valid events: ${valid()}.`);
    } else if (label !== undefined) {
      throw new TypeError(`"${questionId}" is a ${question.type} question; use "${questionId}" without a label.`);
    }
    checkPolicy(event, question, policy);
    if (isAction(handler) && handler.platform !== "*" && handler.platform !== this.source.platform) {
      throw new TypeError(
        `${handler.name} is a ${handler.platform} action, but ${this.source.id} is a ${this.source.platform} source.`,
      );
    }

    const name = isAction(handler) ? handler.name : (handler as { name?: string }).name || "handler";
    return {
      event,
      question: questionId,
      ...(label === undefined ? {} : { label }),
      policy,
      handler: handler as Registration["handler"],
      name,
    };
  }

  // -------------------------------------------------------------------------
  // Running on its own
  // -------------------------------------------------------------------------

  async start(options: StartOptions = {}): Promise<void> {
    this.#checkSolo();
    if (this.#status === "running") return;
    this.#status = "running";
    try {
      await this.#soloRuntime(options).start();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async run(options: StartOptions = {}): Promise<MonitorStats> {
    this.#checkSolo();
    if (this.#status === "running") {
      throw new Error("This monitor is already running. Use run() on its own, or start() and stop().");
    }
    if (deliveryOf(this.source) === "push") {
      throw new Error(
        `${this.id} only receives webhooks, so run() has nothing to read. Mount runtime().handle in your web app instead.`,
      );
    }
    this.#status = "running";
    try {
      await this.#soloRuntime(options).runOnce();
      await this.idle();
    } finally {
      await this.stop();
    }
    return this.stats();
  }

  stop(): Promise<void> {
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    this.#status = "stopped";
    await this.#solo?.halt();
    await Promise.allSettled([...this.runs].map((run) => run.stop()));
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
    await Promise.allSettled(this.#cleanups.splice(0).map(async (cleanup) => cleanup()));
    try {
      await this.#solo?.store.flush?.();
    } catch (error) {
      this.log.warn("couldn't save the store:", error);
    }
  }

  async idle(): Promise<void> {
    for (;;) {
      const busy = [...this.runs].filter((run) => !run.isIdle);
      if (busy.length === 0 && this.#pending.size === 0) return;
      await Promise.allSettled([...busy.map((run) => run.idle()), ...this.#pending]);
    }
  }

  stats(): MonitorStats {
    const c = this.counters;
    let inflight = 0;
    let queued = 0;
    let running = 0;
    for (const run of this.runs) {
      inflight += run.inflight;
      queued += run.queued;
      if (run.status === "active") running++;
    }
    return {
      received: c.received,
      judged: c.judged,
      cached: c.cached,
      inflight,
      queued,
      running,
      dropped: { ...c.dropped },
      errors: c.errors,
      actions: { ...c.actions },
      latencyMs: { p50: this.latency.at(50), p95: this.latency.at(95) },
      usage: { ...c.usage },
      estimatedCostUsd: estimateCostUsd(c.usage.inputTokens, this.#price),
    };
  }

  #checkSolo(): void {
    if (this.#owner && this.#owner !== this.#solo) {
      throw new Error("This monitor belongs to a runtime. Start it with runtime.start(), or check it with runtime.check().");
    }
    if (this.#status === "stopped") throw new Error(RESTART);
  }

  #soloRuntime(options: StartOptions): JevRuntime {
    const store = options.store ?? (this.source.integration && !options.connections ? fileStore() : memoryStore());
    const solo = new JevRuntime(
      {
        monitors: [this],
        store,
        ...(options.apps ? { apps: options.apps } : {}),
        ...(options.connections ? { connections: options.connections } : {}),
        ...(this.#options.rate ? { rate: this.#options.rate } : {}),
        log: this.log,
        now: this.now,
      },
      { solo: true },
    );
    this.#solo = solo;
    return solo;
  }

  // -------------------------------------------------------------------------
  // For runs and runtimes
  // -------------------------------------------------------------------------

  get stopped(): boolean {
    return this.#status === "stopped";
  }

  get profiled(): boolean {
    return this.#options.profile !== undefined;
  }

  /** A monitor belongs to one runtime, including the one `start()` and `run()` create. */
  adopt(owner: JevRuntime): void {
    if (this.#owner && this.#owner !== owner) {
      throw new Error(`The monitor "${this.id}" already belongs to a runtime. Create a separate monitor for each runtime.`);
    }
    this.#owner = owner;
  }

  /** Throws when native actions are armed on a source that can't act. */
  checkArmed(): void {
    const armed = !this.dryRun && this.outcomes.some((r) => isAction(r.handler));
    if (armed && this.source.canAct === false) {
      throw new Error(
        `${this.source.id} can't run native actions because it isn't authenticated. ` +
          "Read it as a signed-in account, or keep dryRun: true to see what would happen.",
      );
    }
  }

  client(): JevClient {
    this.#client ??= this.#options.client ?? new TypeSafeClient();
    return this.#client;
  }

  async profileOf(connection: ConnectionInfo | undefined): Promise<JsonValue | undefined> {
    const profile = this.#options.profile as ((connection: ConnectionInfo | undefined) => unknown) | undefined;
    return profile ? ((await profile(connection)) as JsonValue | undefined) : undefined;
  }

  async budgetFor(connection: ConnectionInfo | undefined, store: Store): Promise<Budget | undefined> {
    const option = this.#options.budget;
    if (!option) return undefined;
    if (option instanceof DailyBudget) return sharedBudget(option);

    const total = option.inputTokensPerDay;
    if (total !== undefined) this.#budget ??= new StoredBudget(total, store, [this.id], this.now);
    const each = option.perConnection?.inputTokensPerDay;
    let own: Budget | undefined;
    if (each !== undefined && connection) {
      own = this.#connectionBudgets.get(connection.id);
      if (!own) {
        own = new StoredBudget(each, store, [this.id, connection.id], this.now);
        this.#connectionBudgets.set(connection.id, own);
      }
    }
    const budget = allOf([this.#budget, own]);
    await budget?.load?.();
    return budget;
  }

  emit<E extends SpecialEventName>(name: E, payload: AnyEvent[E], run?: Run): void {
    const handlers = this.#special.get(name);
    if (!handlers || handlers.size === 0) {
      if (name === "error") {
        const { error, phase, connection } = payload as ErrorEvent;
        const where = connection ? ` (${connection.label ?? connection.id})` : "";
        this.log.warn(`${this.id} ${phase} error${where}:`, error);
      }
      return;
    }
    for (const handler of handlers) {
      try {
        const result = (handler as (event: AnyEvent[E]) => unknown)(payload);
        if (isThenable(result)) this.track(Promise.resolve(result).catch((error: unknown) => this.#crashed(name, error, payload, run)), run);
      } catch (error) {
        this.#crashed(name, error, payload, run);
      }
    }
  }

  /** Keep the monitor busy until `promise` settles. */
  track(promise: Promise<unknown>, run?: Run): void {
    if (run && run.status !== "stopped") return run.track(promise);
    const tracked: Promise<unknown> = promise
      .catch((error: unknown) => this.log.error("unexpected error:", error))
      .finally(() => this.#pending.delete(tracked));
    this.#pending.add(tracked);
  }

  #crashed<E extends SpecialEventName>(name: E, error: unknown, payload: AnyEvent[E], run: Run | undefined): void {
    if (name === "error") {
      this.log.error("an error handler threw:", error);
      return;
    }
    const about = (name === "action" ? (payload as ActionEvent).event : payload) as { item?: Item; connection?: ConnectionInfo };
    this.counters.errors++;
    this.emit(
      "error",
      {
        error,
        phase: "handler",
        monitor: this.id,
        ...(about.item ? { item: about.item } : {}),
        ...(about.connection ? { connection: about.connection } : {}),
      },
      run,
    );
  }
}
