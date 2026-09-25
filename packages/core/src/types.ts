import type {
  ChoiceQuestion,
  JsonValue,
  Questions,
  RequestOptions,
  ScoreQuestion,
  SystemOneRequest,
  SystemOneResult,
} from "@typesafe-ai/sdk";

import type { Logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Items and sources
// ---------------------------------------------------------------------------

export interface Author {
  id: string;
  name: string;
  /** Platform roles such as "broadcaster", "moderator", "vip", "subscriber" or "owner". */
  roles?: readonly string[];
}

/** One unit of a stream: a chat message, a comment, an email, a calendar event. */
export interface Item<Raw = unknown> {
  /** Unique within its source. */
  id: string;
  /** The main text Jev judges. */
  text: string;
  author?: Author;
  /** When the item was created at its origin. */
  at: Date;
  /** Lean, JSON-safe facts shown to Jev next to the text, such as `{ firstMessage: true }`. */
  facts?: Record<string, JsonValue>;
  /** The original platform payload. Never sent to Jev. */
  raw?: Raw;
}

export interface SourceContext<I extends Item> {
  /** Hand an item to the listener. */
  emit(item: I): void;
  /** Aborted when the listener stops. Sources must stop producing and clean up. */
  signal: AbortSignal;
  log: Logger;
  /** Report a problem. Non-fatal errors are surfaced as `error` events; fatal ones also stop the listener. */
  fail(error: unknown, options?: { fatal?: boolean }): void;
  /** Finite sources call this after their last item, so `listener.run()` can finish. */
  end(): void;
}

export interface SourceDefaults {
  /** Items older than this when their turn comes are dropped. */
  maxLagMs?: number;
  /** How many preceding items to show Jev as context. */
  recent?: number;
}

export interface Source<I extends Item = Item, P extends string = string> {
  /** A readable identifier such as "twitch:chat:mychannel". */
  readonly id: string;
  /** The platform this source belongs to. Native actions must match it. */
  readonly platform: P;
  /** What one item is called ("message", "comment", "email"). Used as its key in Jev's state. */
  readonly noun?: string;
  /** Whether native actions can run for real. Dry-run works regardless. */
  readonly canAct?: boolean;
  readonly defaults?: SourceDefaults;
  /** Connect and start emitting. Resolve once connected; keep emitting until `ctx.signal` aborts. */
  start(ctx: SourceContext<I>): Promise<void> | void;
  /** The lean JSON view of an item that Jev sees. Defaults to text, author and facts. */
  describe?(item: I): JsonValue;
  /** Items from privileged users (broadcaster, moderators...). Native actions never run on them. */
  isProtected?(item: I): boolean;
}

export type AnySource = Source<any, string>;
export type ItemOf<S> = S extends Source<infer I, string> ? I : never;
export type PlatformOf<S> = S extends Source<Item, infer P> ? P : never;

// ---------------------------------------------------------------------------
// Jev client
// ---------------------------------------------------------------------------

/** The slice of `TypeSafeClient` Jev Events uses. Pass a fake in tests. */
export interface JevClient {
  systemOne<const Q extends Questions>(
    request: SystemOneRequest<Q>,
    options?: RequestOptions,
  ): PromiseLike<SystemOneResult<Q>>;
}

export type Answers<Q extends Questions> = SystemOneResult<Q>["answers"];

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

type QuestionId<Q> = keyof Q & string;

/**
 * Outcome event names generated from the questions:
 * a choice question `kind` yields `"kind:<label>"`, a noul or score question `hateful` yields `"hateful"`.
 */
export type OutcomeEventName<Q extends Questions> = {
  [K in QuestionId<Q>]: Q[K] extends ChoiceQuestion<infer C> ? `${K}:${keyof C & string}` : K;
}[QuestionId<Q>];

export type SpecialEventName = "judged" | "review" | "action" | "dropped" | "error";

export interface ProbabilityPolicy {
  /** Fire when the probability reaches this. Choice events default to "fires when chosen"; noul events to 0.5. */
  min?: number;
  /** Emit a `review` event instead when the probability is at least this but below `min`. */
  review?: number;
}

export interface ScorePolicy {
  /** Fire when the expected score reaches this. Defaults to the middle of the rubric. */
  atLeast?: number;
  /** Emit a `review` event instead when the score is at least this but below `atLeast`. */
  review?: number;
}

export type PolicyFor<Q extends Questions, E> = E extends `${string}:${string}`
  ? ProbabilityPolicy
  : E extends QuestionId<Q>
    ? Q[E] extends ScoreQuestion
      ? ScorePolicy
      : ProbabilityPolicy
    : never;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** An item with Jev's answers to every question. */
export interface JudgedEvent<I extends Item = Item, Q extends Questions = Questions> {
  readonly item: I;
  readonly answers: Answers<Q>;
  readonly model: string;
  readonly latencyMs: number;
  readonly usage: Usage;
  /** True when answers came from the text cache instead of a new request. */
  readonly cached: boolean;
  /** True when native actions only log what they would do. */
  readonly dryRun: boolean;
  /** True when the item comes from a privileged user; native actions skip it. */
  readonly protected: boolean;
}

export interface Trigger {
  /** The event name that fired, e.g. "kind:question". */
  readonly event: string;
  readonly question: string;
  /** The choice label, for choice events. */
  readonly label?: string;
  /** Probability of the label (choice) or of yes (noul). */
  readonly probability?: number;
  /** Expected score, for score events. */
  readonly score?: number;
}

/** A judged item that crossed a handler's threshold. */
export interface TriggeredEvent<I extends Item = Item, Q extends Questions = Questions>
  extends JudgedEvent<I, Q> {
  readonly trigger: Trigger;
}

export interface ReviewEvent<I extends Item = Item, Q extends Questions = Questions>
  extends TriggeredEvent<I, Q> {
  /** Name of the handler that did not run because the answer was uncertain. */
  readonly handler: string;
}

export type ActionStatus = "done" | "dry-run" | "skipped" | "failed";

export interface ActionEvent<I extends Item = Item, Q extends Questions = Questions> {
  readonly action: string;
  readonly description: string;
  readonly status: ActionStatus;
  readonly reason?: string;
  readonly event: TriggeredEvent<I, Q>;
}

export type DropReason = "filtered" | "stale" | "overflow" | "budget" | "stopped";

export interface DroppedEvent<I extends Item = Item> {
  readonly item: I;
  readonly reason: DropReason;
}

export type ErrorPhase = "source" | "judge" | "handler" | "action";

export interface ErrorEvent<I extends Item = Item> {
  readonly error: unknown;
  readonly phase: ErrorPhase;
  readonly item?: I;
}

// ---------------------------------------------------------------------------
// Handlers and actions
// ---------------------------------------------------------------------------

export const ACTION: unique symbol = Symbol.for("jev-events.action");

/**
 * A native platform action such as `twitch.timeout()`. Actions are gated by dry-run,
 * never run on protected items, and are type-checked against the source's platform.
 */
export interface Action<P extends string = string, I extends Item = Item> {
  readonly [ACTION]: true;
  /** The platform the action belongs to, or "*" for actions that work with any source. */
  readonly platform: P;
  /** A dotted name such as "twitch.timeout". */
  readonly name: string;
  /** Human-readable description for logs: "timeout viewer123 for 600s". */
  describe(event: TriggeredEvent<I>): string;
  run(event: TriggeredEvent<I>, source: Source<I, string>): Promise<void>;
}

export type HandlerFn<I extends Item, Q extends Questions> = (
  event: TriggeredEvent<I, Q>,
) => unknown;

export type OutcomeHandler<S extends AnySource, Q extends Questions> =
  | HandlerFn<ItemOf<S>, Q>
  | Action<PlatformOf<S> | "*", ItemOf<S>>;

export interface SpecialEventMap<I extends Item, Q extends Questions> {
  judged: JudgedEvent<I, Q>;
  review: ReviewEvent<I, Q>;
  action: ActionEvent<I, Q>;
  dropped: DroppedEvent<I>;
  error: ErrorEvent<I>;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface ListenerStats {
  received: number;
  judged: number;
  cached: number;
  inflight: number;
  queued: number;
  dropped: Record<DropReason, number>;
  errors: number;
  actions: Record<ActionStatus, number>;
  latencyMs: { p50: number | null; p95: number | null };
  usage: Usage;
  /** Estimated spend in USD from input tokens at the configured price. */
  estimatedCostUsd: number;
}
