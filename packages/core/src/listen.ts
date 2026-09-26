import {
  TypeSafeClient,
  type EntryType,
  type JsonValue,
  type Question,
  type Questions,
  type ResultFor,
  type SystemOneResult,
} from "@typesafe-ai/sdk";

import { isAction } from "./action.js";
import { createLogger, type Logger, type LogLevel } from "./logger.js";
import { evaluate, type OutcomeSpec } from "./policy.js";
import { estimateCostUsd, JEV_USD_PER_MILLION_INPUT_TOKENS } from "./pricing.js";
import { DailyBudget, Percentiles, TokenBucket } from "./scheduler.js";
import { buildState, inspectQuestions } from "./state.js";
import type {
  Action,
  ActionStatus,
  AnySource,
  DropReason,
  HandlerFn,
  Item,
  ItemOf,
  JevClient,
  JudgedEvent,
  ListenerStats,
  OutcomeEventName,
  OutcomeHandler,
  PolicyFor,
  ProbabilityPolicy,
  ScorePolicy,
  SpecialEventMap,
  SpecialEventName,
  Trigger,
  TriggeredEvent,
} from "./types.js";

export interface ListenOptions<I extends Item = Item> {
  /** The Jev client. Defaults to `new TypeSafeClient()`, which reads `TYPESAFE_API_KEY`. */
  client?: JevClient;
  /** Model override, e.g. "jev-1.13.0". Defaults to the client's default (`jev-latest`). */
  model?: string;
  /** Native actions only log what they would do. Default: true. Set false to arm them. */
  dryRun?: boolean;
  /** Return false to skip an item before it is judged (and before it costs anything). */
  filter?: (item: I) => boolean;
  /** Extra protection on top of the source's own (for example an allowlist). Return a string to give the reason. */
  protect?: (item: I) => boolean | string;
  context?: {
    /** How many preceding items to show Jev. Defaults to the source's suggestion. */
    recent?: number;
    /** Static facts about the stream, such as channel rules or the game being played. */
    about?: JsonValue;
  };
  /** Build Jev's state yourself instead of using the source's default. */
  state?: (item: I, context: { recent: readonly I[]; about: JsonValue | undefined }) => EntryType;
  /**
   * Point questions at this key of the state. Defaults to the source's noun whenever context
   * is present, so context is read as context. `false` sends questions unchanged.
   */
  inspect?: string | false;
  rate?: {
    /** Sustained requests per second. Default 18, under Jev's 1,200 requests per minute. */
    perSecond?: number;
    /** Requests allowed at once after a quiet period. Default 20. */
    burst?: number;
    /** Requests in flight at once. Default 16. */
    concurrency?: number;
  };
  /** Items waiting for a request slot. The oldest are dropped beyond this. Default 1000. */
  maxQueue?: number;
  /** Drop items that waited longer than this. Defaults to the source's suggestion. */
  maxLagMs?: number;
  /** Reuse answers for identical text (copy-paste floods) for `ttlMs`. Default off. */
  cache?: boolean | { ttlMs?: number; max?: number };
  /**
   * Stop judging once this many input tokens were spent in the current UTC day. Pass a
   * `DailyBudget` instead to share one budget between listeners.
   */
  budget?: { inputTokensPerDay?: number } | DailyBudget;
  /** Per-attempt timeout for Jev requests in milliseconds. */
  timeoutMs?: number;
  log?: Logger | LogLevel;
  pricing?: { usdPerMillionInputTokens?: number };
  /** Clock override for tests. */
  now?: () => number;
}

export interface Listener<S extends AnySource, Q extends Questions> {
  readonly source: S;
  readonly questions: Q;
  /** Observe every judgment, review, action, drop or error. */
  on<E extends SpecialEventName>(event: E, handler: (event: SpecialEventMap<ItemOf<S>, Q>[E]) => unknown): this;
  /** Run a handler or native action when an outcome fires. */
  on<E extends OutcomeEventName<Q>>(event: E, handler: OutcomeHandler<S, Q>): this;
  /** Run a handler or native action when an outcome fires under a policy such as `{ min: 0.85 }`. */
  on<E extends OutcomeEventName<Q>>(event: E, policy: PolicyFor<Q, E>, handler: OutcomeHandler<S, Q>): this;
  off(event: string, handler: unknown): this;
  /** Attach a plugin such as `logTo("audit.jsonl")`. A returned function runs on stop. */
  use(plugin: Plugin<S, Q>): this;
  /** Connect the source. Resolves once it is live. */
  start(): Promise<void>;
  /** Disconnect and wait for in-flight work. */
  stop(): Promise<void>;
  /** Resolves when nothing is queued, in flight or running. */
  idle(): Promise<void>;
  /** Start, wait for a finite source to end and every item to be handled, then stop. */
  run(): Promise<ListenerStats>;
  stats(): ListenerStats;
}

export type Plugin<S extends AnySource, Q extends Questions> = (
  listener: Listener<S, Q>,
) => void | (() => unknown);

/**
 * Turn a source into typed, semantic events.
 *
 * @example
 * ```ts
 * const chat = listen(twitch.chat("mychannel"), {
 *   kind: choice("What is this chat message?", { question: null, hateful: null, other: null }),
 * });
 * chat.on("kind:hateful", { min: 0.85 }, twitch.timeout({ seconds: 600 }));
 * chat.on("kind:question", (e) => overlay.push(e.item.text));
 * await chat.start();
 * ```
 */
export function listen<S extends AnySource, const Q extends Questions>(
  source: S,
  questions: Q,
  options: ListenOptions<ItemOf<S>> = {},
): Listener<S, Q> {
  return new JevListener(source, questions, options);
}

const SPECIAL = new Set<string>(["judged", "review", "action", "dropped", "error"] satisfies SpecialEventName[]);
const NO_ITEMS: readonly never[] = Object.freeze([]);

interface Job {
  item: Item;
  recent: readonly Item[];
  receivedAt: number;
}

interface Judgment {
  result: SystemOneResult<Questions>;
  latencyMs: number;
}

interface Registration extends OutcomeSpec {
  handler: HandlerFn<Item, Questions> | Action<string, Item>;
  name: string;
}

type AnyHandler = (event: never) => unknown;

class JevListener<S extends AnySource, Q extends Questions> implements Listener<S, Q> {
  readonly source: S;
  readonly questions: Q;

  readonly #options: ListenOptions<Item>;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #dryRun: boolean;
  readonly #recent: number;
  readonly #about: JsonValue | undefined;
  readonly #maxQueue: number;
  readonly #maxLagMs: number;
  readonly #concurrency: number;
  readonly #ask: Questions;
  readonly #bucket: TokenBucket;
  readonly #budget: DailyBudget | undefined;
  readonly #cache: TextCache | undefined;
  readonly #price: number;

  #client: JevClient | undefined;
  #controller: AbortController | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #status: "idle" | "starting" | "running" | "stopped" = "idle";
  #ended = false;
  #inflight = 0;
  readonly #outcomes: Registration[] = [];
  readonly #special = new Map<string, Set<AnyHandler>>();
  readonly #queue: Job[] = [];
  readonly #history: Item[] = [];
  readonly #pending = new Set<Promise<unknown>>();
  readonly #cleanups: Array<() => unknown> = [];
  readonly #idleWaiters: Array<() => void> = [];
  readonly #endWaiters: Array<() => void> = [];
  readonly #latency = new Percentiles();
  readonly #stats = {
    received: 0,
    judged: 0,
    cached: 0,
    errors: 0,
    dropped: { filtered: 0, stale: 0, overflow: 0, budget: 0, stopped: 0 } satisfies Record<DropReason, number>,
    actions: { done: 0, "dry-run": 0, skipped: 0, failed: 0 } satisfies Record<ActionStatus, number>,
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  constructor(source: S, questions: Q, options: ListenOptions<ItemOf<S>>) {
    const ids = Object.keys(questions);
    if (ids.length === 0) throw new TypeError("listen() needs at least one question.");
    for (const id of ids) {
      if (id.includes(":")) throw new TypeError(`Question id "${id}" can't contain ":".`);
      if (SPECIAL.has(id)) throw new TypeError(`Question id "${id}" is reserved for a built-in event.`);
    }

    this.source = source;
    this.questions = questions;
    this.#options = options as ListenOptions<Item>;
    this.#log = typeof options.log === "object" ? options.log : createLogger(options.log ?? "info");
    this.#now = options.now ?? Date.now;
    this.#dryRun = options.dryRun ?? true;
    this.#recent = options.context?.recent ?? source.defaults?.recent ?? 0;
    this.#about = options.context?.about;
    this.#maxQueue = options.maxQueue ?? 1000;
    this.#maxLagMs = options.maxLagMs ?? source.defaults?.maxLagMs ?? Number.POSITIVE_INFINITY;
    this.#concurrency = options.rate?.concurrency ?? 16;
    this.#bucket = new TokenBucket(options.rate?.perSecond ?? 18, options.rate?.burst ?? 20, this.#now);
    this.#price = options.pricing?.usdPerMillionInputTokens ?? JEV_USD_PER_MILLION_INPUT_TOKENS;

    const budget = options.budget;
    this.#budget =
      budget instanceof DailyBudget
        ? budget
        : budget?.inputTokensPerDay === undefined
          ? undefined
          : new DailyBudget(budget.inputTokensPerDay, this.#now);

    const cache = options.cache;
    this.#cache = cache
      ? new TextCache(
          typeof cache === "object" ? (cache.ttlMs ?? 60_000) : 60_000,
          typeof cache === "object" ? (cache.max ?? 1000) : 1000,
          this.#now,
        )
      : undefined;

    const inspectKey =
      options.inspect === false
        ? undefined
        : typeof options.inspect === "string"
          ? options.inspect
          : options.state
            ? undefined
            : this.#recent > 0 || this.#about !== undefined
              ? (source.noun ?? "item")
              : undefined;
    this.#ask = inspectKey ? inspectQuestions(questions, inspectKey) : questions;
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
    this.#outcomes.push(this.#register(event, policy, handler));
    return this;
  }

  off(event: string, handler: unknown): this {
    if (SPECIAL.has(event)) {
      this.#special.get(event)?.delete(handler as AnyHandler);
      return this;
    }
    const index = this.#outcomes.findIndex((r) => r.event === event && r.handler === handler);
    if (index !== -1) this.#outcomes.splice(index, 1);
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
    const valid = () => this.#eventNames().join(", ");

    if (!question) throw new TypeError(`Unknown event "${event}". Valid events: ${valid()}.`);
    if (question.type === "choice") {
      if (label === undefined) {
        throw new TypeError(`"${questionId}" is a choice question; listen for one of its labels: ${valid()}.`);
      }
      if (!Object.hasOwn(question.criteria, label)) throw new TypeError(`Unknown event "${event}". Valid events: ${valid()}.`);
    } else if (label !== undefined) {
      throw new TypeError(`"${questionId}" is a ${question.type} question; listen for "${questionId}" without a label.`);
    }
    checkPolicy(event, question, policy);

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

  #eventNames(): string[] {
    return Object.entries(this.questions).flatMap(([id, q]) =>
      q.type === "choice" ? Object.keys(q.criteria).map((label) => `${id}:${label}`) : [id],
    );
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.#status === "running" || this.#status === "starting") return;
    if (this.#status === "stopped") {
      throw new Error("A stopped listener can't be restarted. Create a new one with listen().");
    }
    const armed = !this.#dryRun && this.#outcomes.some((r) => isAction(r.handler));
    if (armed && this.source.canAct === false) {
      throw new Error(
        `${this.source.id} can't run native actions because it isn't authenticated. ` +
          "Pass credentials to the source, or keep dryRun: true to see what would happen.",
      );
    }

    this.#client ??= this.#options.client ?? new TypeSafeClient();
    const controller = new AbortController();
    this.#controller = controller;
    this.#status = "starting";
    try {
      await this.source.start({
        emit: (item) => this.#receive(item),
        signal: controller.signal,
        log: this.#log,
        fail: (error, options) => this.#sourceFailed(error, options?.fatal ?? false),
        end: () => this.#sourceEnded(),
      });
    } catch (error) {
      this.#status = "stopped";
      controller.abort();
      throw error;
    }
    if (this.#status === "starting") this.#status = "running";
  }

  async stop(): Promise<void> {
    if (this.#status === "stopped") return;
    this.#status = "stopped";
    this.#controller?.abort();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const job of this.#queue.splice(0)) this.#drop(job.item, "stopped");
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
    await Promise.allSettled(this.#cleanups.splice(0).map(async (cleanup) => cleanup()));
    this.#ended = true;
    this.#flush(this.#endWaiters);
    this.#flush(this.#idleWaiters);
  }

  idle(): Promise<void> {
    if (this.#isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  async run(): Promise<ListenerStats> {
    await this.start();
    if (!this.#ended) await new Promise<void>((resolve) => this.#endWaiters.push(resolve));
    await this.idle();
    await this.stop();
    return this.stats();
  }

  stats(): ListenerStats {
    const s = this.#stats;
    return {
      received: s.received,
      judged: s.judged,
      cached: s.cached,
      inflight: this.#inflight,
      queued: this.#queue.length,
      dropped: { ...s.dropped },
      errors: s.errors,
      actions: { ...s.actions },
      latencyMs: { p50: this.#latency.at(50), p95: this.#latency.at(95) },
      usage: { ...s.usage },
      estimatedCostUsd: estimateCostUsd(s.usage.inputTokens, this.#price),
    };
  }

  #sourceFailed(error: unknown, fatal: boolean): void {
    this.#stats.errors++;
    this.#emit("error", { error, phase: "source", ...(fatal ? { fatal } : {}) });
    if (fatal) void this.stop();
  }

  #sourceEnded(): void {
    this.#ended = true;
    this.#flush(this.#endWaiters);
    this.#checkIdle();
  }

  // -------------------------------------------------------------------------
  // Pipeline
  // -------------------------------------------------------------------------

  #receive(item: Item): void {
    if (this.#status !== "running" && this.#status !== "starting") return;
    this.#stats.received++;

    const recent = this.#recent > 0 ? this.#history.slice(-this.#recent) : NO_ITEMS;
    if (this.#recent > 0) {
      this.#history.push(item);
      if (this.#history.length > this.#recent) this.#history.shift();
    }

    if (this.#options.filter) {
      let keep: boolean;
      try {
        keep = this.#options.filter(item);
      } catch (error) {
        this.#stats.errors++;
        this.#emit("error", { error, phase: "handler", item });
        keep = false;
      }
      if (!keep) return this.#drop(item, "filtered");
    }
    if (this.#budget?.exhausted) return this.#drop(item, "budget");

    const hit = this.#cache?.get(item.text);
    if (hit) return this.#follow(item, hit);

    this.#queue.push({ item, recent, receivedAt: this.#now() });
    if (this.#queue.length > this.#maxQueue) {
      const oldest = this.#queue.shift();
      if (oldest) this.#drop(oldest.item, "overflow");
    }
    this.#pump();
  }

  #pump(): void {
    if (this.#status === "stopped") return;
    while (this.#queue.length > 0 && this.#inflight < this.#concurrency) {
      const job = this.#queue[0] as Job;
      if (this.#now() - job.receivedAt > this.#maxLagMs) {
        this.#queue.shift();
        this.#drop(job.item, "stale");
        continue;
      }
      if (this.#budget?.exhausted) {
        this.#queue.shift();
        this.#drop(job.item, "budget");
        continue;
      }
      if (!this.#bucket.tryTake()) {
        this.#schedule(this.#bucket.msUntilNext());
        return;
      }
      this.#queue.shift();
      this.#judge(job);
    }
    this.#checkIdle();
  }

  #schedule(ms: number): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#pump();
    }, Math.max(1, ms));
  }

  #judge(job: Job): void {
    this.#inflight++;
    const client = this.#client as JevClient;
    const signal = this.#controller?.signal;
    const request = (async (): Promise<Judgment> => {
      const started = this.#now();
      const result = await client.systemOne(
        {
          state: this.#state(job),
          questions: this.#ask,
          ...(this.#options.model ? { model: this.#options.model } : {}),
        },
        {
          ...(signal ? { signal } : {}),
          ...(this.#options.timeoutMs ? { timeout: this.#options.timeoutMs } : {}),
        },
      );
      return { result, latencyMs: this.#now() - started };
    })();
    this.#cache?.set(job.item.text, request);

    this.#track(
      request
        .then(
          ({ result, latencyMs }) => {
            this.#latency.add(latencyMs);
            this.#stats.usage.inputTokens += result.usage.input_tokens;
            this.#stats.usage.outputTokens += result.usage.output_tokens;
            this.#budget?.spend(result.usage.input_tokens);
            this.#deliver(job.item, result, latencyMs, false);
          },
          (error: unknown) => this.#judgeFailed(job.item, error),
        )
        .finally(() => {
          this.#inflight--;
          this.#pump();
        }),
    );
  }

  #follow(item: Item, request: Promise<Judgment>): void {
    this.#track(
      request.then(
        ({ result }) => {
          this.#stats.cached++;
          this.#deliver(item, result, 0, true);
        },
        (error: unknown) => this.#judgeFailed(item, error),
      ),
    );
  }

  #state(job: Job): EntryType {
    const parts = { recent: job.recent, about: this.#about };
    if (this.#options.state) return this.#options.state(job.item, parts);
    return buildState(this.source, { item: job.item, ...parts });
  }

  #judgeFailed(item: Item, error: unknown): void {
    if (this.#status === "stopped") return;
    this.#stats.errors++;
    this.#emit("error", { error, phase: "judge", item });
  }

  #deliver(item: Item, result: SystemOneResult<Questions>, latencyMs: number, cached: boolean): void {
    if (this.#status === "stopped") return;
    this.#stats.judged++;
    const event: JudgedEvent = {
      item,
      answers: result.answers,
      model: result.model,
      latencyMs,
      usage: cached
        ? { inputTokens: 0, outputTokens: 0 }
        : { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens },
      cached,
      dryRun: this.#dryRun,
      ...this.#protection(item),
    };
    this.#emit("judged", event);

    for (const registration of this.#outcomes) {
      const question = this.questions[registration.question] as Question;
      const answer = event.answers[registration.question] as ResultFor<Question> | undefined;
      if (!answer) continue;
      const verdict = evaluate(registration, question, answer);
      if (!verdict) continue;
      const triggered: TriggeredEvent = { ...event, trigger: verdict.trigger };
      if (verdict.kind === "review") {
        this.#emit("review", { ...triggered, handler: registration.name });
      } else {
        this.#track(this.#runHandler(registration, triggered));
      }
    }
  }

  async #runHandler(registration: Registration, event: TriggeredEvent): Promise<void> {
    const { handler } = registration;
    if (isAction(handler)) return this.#runAction(handler, event);
    try {
      await handler(event);
    } catch (error) {
      this.#stats.errors++;
      this.#emit("error", { error, phase: "handler", item: event.item });
    }
  }

  async #runAction(action: Action<string, Item>, event: TriggeredEvent): Promise<void> {
    let description: string;
    try {
      description = action.describe(event);
    } catch {
      description = action.name;
    }
    const report = (status: ActionStatus, reason?: string) => {
      this.#stats.actions[status]++;
      this.#emit("action", { action: action.name, description, status, ...(reason ? { reason } : {}), event });
    };

    if (event.protected) return report("skipped", event.protectedBecause ?? "protected user");
    if (event.dryRun) {
      this.#log.info(`[dry-run] would ${description} (${summarize(event.trigger)})`);
      return report("dry-run");
    }
    if (this.source.canAct === false) return report("skipped", `${this.source.id} isn't authenticated`);
    try {
      await action.run(event, this.source);
      report("done");
    } catch (error) {
      report("failed", error instanceof Error ? error.message : String(error));
      this.#stats.errors++;
      this.#emit("error", { error, phase: "action", item: event.item });
    }
  }

  #protection(item: Item): { protected: boolean; protectedBecause?: string } {
    let verdict: boolean | string | undefined;
    try {
      verdict = this.source.isProtected?.(item) || this.#options.protect?.(item);
    } catch {
      // When protection can't be decided, err on the side of not acting.
      return { protected: true, protectedBecause: "couldn't check whether the item is protected" };
    }
    if (typeof verdict === "string" && verdict) return { protected: true, protectedBecause: verdict };
    return { protected: Boolean(verdict) };
  }

  #drop(item: Item, reason: DropReason): void {
    this.#stats.dropped[reason]++;
    this.#emit("dropped", { item, reason });
  }

  #emit<E extends SpecialEventName>(name: E, payload: SpecialEventMap<Item, Questions>[E]): void {
    const handlers = this.#special.get(name);
    if (!handlers || handlers.size === 0) {
      if (name === "error") {
        const { error, phase } = payload as SpecialEventMap<Item, Questions>["error"];
        this.#log.warn(`${phase} error:`, error);
      }
      return;
    }
    for (const handler of handlers) {
      try {
        const result = (handler as (event: typeof payload) => unknown)(payload);
        if (isThenable(result)) this.#track(Promise.resolve(result).catch((error) => this.#crashed(name, error)));
      } catch (error) {
        this.#crashed(name, error);
      }
    }
  }

  #crashed(name: SpecialEventName, error: unknown): void {
    if (name === "error") {
      this.#log.error("an error handler threw:", error);
      return;
    }
    this.#stats.errors++;
    this.#emit("error", { error, phase: "handler" });
  }

  #track(promise: Promise<unknown>): void {
    this.#pending.add(promise);
    void promise.finally(() => {
      this.#pending.delete(promise);
      this.#checkIdle();
    });
  }

  #isIdle(): boolean {
    return this.#queue.length === 0 && this.#inflight === 0 && this.#pending.size === 0;
  }

  #checkIdle(): void {
    if (this.#isIdle()) this.#flush(this.#idleWaiters);
  }

  #flush(waiters: Array<() => void>): void {
    for (const resolve of waiters.splice(0)) resolve();
  }
}

class TextCache {
  readonly #entries = new Map<string, { value: Promise<Judgment>; expires: number }>();
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;

  constructor(ttlMs: number, max: number, now: () => number) {
    this.#ttlMs = ttlMs;
    this.#max = max;
    this.#now = now;
  }

  get(text: string): Promise<Judgment> | undefined {
    const key = normalize(text);
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expires < this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(text: string, value: Promise<Judgment>): void {
    const key = normalize(text);
    this.#entries.delete(key);
    this.#entries.set(key, { value, expires: this.#now() + this.#ttlMs });
    if (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    value.catch(() => this.#entries.delete(key));
  }
}

function checkPolicy(event: string, question: Question, policy: ProbabilityPolicy & ScorePolicy): void {
  const inRange = (key: string, value: number | undefined, max: number) => {
    if (value !== undefined && !(value >= 0 && value <= max)) {
      throw new RangeError(`"${key}" for "${event}" must be between 0 and ${max}, got ${value}.`);
    }
  };
  if (question.type === "score") {
    if (policy.min !== undefined) throw new TypeError(`"${event}" is a score; use { atLeast } instead of { min }.`);
    const top = question.criteria.length - 1;
    inRange("atLeast", policy.atLeast, top);
    inRange("review", policy.review, top);
  } else {
    if (policy.atLeast !== undefined) throw new TypeError(`"${event}" is a probability; use { min } instead of { atLeast }.`);
    inRange("min", policy.min, 1);
    inRange("review", policy.review, 1);
  }
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function summarize(trigger: Trigger): string {
  if (trigger.score !== undefined) return `${trigger.event} score=${trigger.score.toFixed(2)}`;
  if (trigger.probability !== undefined) return `${trigger.event} p=${trigger.probability.toFixed(2)}`;
  return trigger.event;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === "function";
}
