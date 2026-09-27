import type {
  ChoiceQuestion,
  JsonValue,
  Questions,
  RequestOptions,
  ScoreQuestion,
  SystemOneRequest,
  SystemOneResult,
} from "@typesafe-ai/sdk";

import type { App, Connection, ConnectionInfo, Credentials } from "./connection.js";
import type { Duration } from "./duration.js";
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
  /** Unique within its source and connection. */
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

/** Where a source left off for one connection. Saved in the store. */
export interface Cursor {
  get<T extends JsonValue = JsonValue>(): Promise<T | undefined>;
  set(value: JsonValue): Promise<void>;
}

/** What a source gets while it runs for one connection, or once for a fixed stream. */
export interface SourceContext<I extends Item = Item, S = unknown> {
  /**
   * Hand an item to the monitor. Resolves once it is queued; it is judged later. Items with an
   * id the monitor has already seen for this connection are dropped as duplicates.
   */
  emit(item: I): Promise<void>;
  /** Aborted when the run stops. Sources must stop producing and clean up. */
  readonly signal: AbortSignal;
  readonly log: Logger;
  /**
   * Report a problem. Non-fatal errors become `error` events. Fatal ones also stop this run; the
   * runtime starts it again later, unless the error needs the user to sign in again.
   */
  fail(error: unknown, options?: { fatal?: boolean }): void;
  /** Finite sources call this after their last item, so `monitor.run()` can finish. */
  end(): void;
  /** The signed-in account this run reads, or undefined for a fixed stream. */
  readonly connection: ConnectionInfo | undefined;
  /** What `source.session()` returned for this connection, such as an API client. */
  readonly session: S;
  readonly cursor: Cursor;
}

/** What `source.session()` gets to build API clients for one connection. */
export interface SessionContext {
  /** The connection with its credentials, or undefined for a fixed stream. */
  readonly connection: Connection | undefined;
  /** The OAuth app registered for this integration with `runtime({ apps })`, if any. */
  readonly app: App | undefined;
  readonly log: Logger;
  readonly signal: AbortSignal;
  /** Save refreshed tokens for this connection. */
  saveCredentials(credentials: Credentials): Promise<void>;
}

/** What `source.receive()` gets when the platform posts to the webhook route. */
export interface PushContext<I extends Item = Item, S = unknown> {
  /** The OAuth app registered for this integration, with the secret to verify requests. */
  readonly app: App | undefined;
  readonly log: Logger;
  /** Active connections for this source's integration, to find the one a request is about. */
  connections(): Promise<ConnectionInfo[]>;
  /** Hand an item to the monitor for one connection, or undefined for a fixed stream. */
  emit(connection: ConnectionInfo | undefined, item: I): Promise<void>;
  /** The session for a connection, such as an API client to fetch the full item. */
  session(connection: ConnectionInfo): Promise<S>;
}

export interface ProtectContext<S = unknown> {
  readonly connection: ConnectionInfo | undefined;
  readonly session: S;
}

export interface SourceDefaults {
  /** Items older than this when their turn comes are dropped. */
  maxLagMs?: number;
  /** How many preceding items to show Jev as context. */
  recent?: number;
  /** How often a polling source checks for new items. Default one minute. */
  every?: Duration;
}

/**
 * One kind of stream an integration offers, such as new emails or a channel's chat.
 *
 * A source delivers items in one or more ways:
 * - `start` holds a connection open and emits as items arrive (chat sockets). Needs a worker.
 * - `check` asks the platform for new items since the cursor (polling). Runs in a worker loop or
 *   from the cron route.
 * - `receive` handles a request the platform posts to the webhook route (push).
 */
export interface Source<I extends Item = Item, P extends string = string, S = unknown> {
  /** A readable identifier such as "google:gmail". Monitors use it as their default id. */
  readonly id: string;
  /** The platform this source belongs to. Native actions must match it. */
  readonly platform: P;
  /** What one item is called ("message", "email"). Used as its key in Jev's state. */
  readonly noun?: string;
  /** Whether native actions can run for real. Dry-run works regardless. */
  readonly canAct?: boolean;
  readonly defaults?: SourceDefaults;
  /**
   * The integration whose connections this source reads, such as "google". Set, the monitor runs
   * once per connection. Unset, it runs once for a fixed stream such as a public chat.
   */
  readonly integration?: string;
  /** Build what the source and its actions need for one connection, such as an API client. */
  session?(ctx: SessionContext): S | Promise<S>;
  /** Connect and start emitting. Resolve once connected; keep emitting until `ctx.signal` aborts. */
  start?(ctx: SourceContext<I, S>): Promise<void> | void;
  /** Emit whatever is new since the cursor, save the new cursor, and resolve. */
  check?(ctx: SourceContext<I, S>): Promise<void>;
  /** Handle a webhook request from the platform. */
  receive?(request: Request, ctx: PushContext<I, S>): Promise<Response>;
  /** The lean JSON view of an item that Jev sees. Defaults to text, author and facts. */
  describe?(item: I): JsonValue;
  /**
   * Items native actions must never touch because of who they're from: a moderator, a colleague.
   * Return a reason, such as "colleague at acme.com", to say why when an action is skipped.
   */
  isProtected?(item: I, ctx: ProtectContext<S>): boolean | string | Promise<boolean | string>;
}

/** A source that reads signed-in accounts, so its events always carry a connection. */
export type ConnectedSource<I extends Item = Item, P extends string = string, S = unknown> = Source<I, P, S> & {
  readonly integration: string;
};

export type AnySource = Source<any, string, any>;
export type ItemOf<S> = S extends Source<infer I, string, any> ? I : never;
export type PlatformOf<S> = S extends Source<any, infer P, any> ? P : never;
export type SessionOf<S> = S extends Source<any, string, infer X> ? X : never;
/** `ConnectionInfo` for sources that read signed-in accounts, possibly undefined otherwise. */
export type ConnectionOf<S> = S extends { readonly integration: string } ? ConnectionInfo : ConnectionInfo | undefined;

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
type AnyConnection = ConnectionInfo | undefined;

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
export interface JudgedEvent<I extends Item = Item, Q extends Questions = Questions, C extends AnyConnection = AnyConnection> {
  readonly item: I;
  readonly answers: Answers<Q>;
  /** The signed-in account the item came from, such as `connection.userId`. Undefined for fixed streams. */
  readonly connection: C;
  /** The id of the monitor that judged the item. */
  readonly monitor: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly usage: Usage;
  /** True when answers came from the text cache instead of a new request. */
  readonly cached: boolean;
  /** True when native actions only report what they would do. */
  readonly dryRun: boolean;
  /** True when native actions must not touch the item because of who it's from. */
  readonly protected: boolean;
  /** Why the item is protected, e.g. "colleague at acme.com". */
  readonly protectedBecause?: string;
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
export interface TriggeredEvent<I extends Item = Item, Q extends Questions = Questions, C extends AnyConnection = AnyConnection>
  extends JudgedEvent<I, Q, C> {
  readonly trigger: Trigger;
}

export interface ReviewEvent<I extends Item = Item, Q extends Questions = Questions, C extends AnyConnection = AnyConnection>
  extends TriggeredEvent<I, Q, C> {
  /** Name of the handler that did not run because the answer was uncertain. */
  readonly handler: string;
}

export type ActionStatus = "done" | "dry-run" | "skipped" | "failed";

export interface ActionEvent<I extends Item = Item, Q extends Questions = Questions, C extends AnyConnection = AnyConnection> {
  readonly action: string;
  readonly description: string;
  readonly status: ActionStatus;
  readonly reason?: string;
  readonly event: TriggeredEvent<I, Q, C>;
}

export type DropReason = "filtered" | "duplicate" | "stale" | "overflow" | "budget" | "stopped";

export interface DroppedEvent<I extends Item = Item, C extends AnyConnection = AnyConnection> {
  readonly item: I;
  readonly reason: DropReason;
  readonly connection: C;
  readonly monitor: string;
}

export type ErrorPhase = "source" | "judge" | "handler" | "action";

export interface ErrorEvent<I extends Item = Item> {
  readonly error: unknown;
  readonly phase: ErrorPhase;
  readonly monitor: string;
  readonly item?: I;
  /** The connection the error happened for, when there is one. */
  readonly connection?: ConnectionInfo;
  /** This run can't go on. The runtime starts it again later unless it needs a new sign-in. */
  readonly fatal?: boolean;
  /** The user has to sign in again; the connection is marked "needs-sign-in" until they do. */
  readonly needsSignIn?: boolean;
}

// ---------------------------------------------------------------------------
// Handlers and actions
// ---------------------------------------------------------------------------

export const ACTION: unique symbol = Symbol.for("jev-events.action");

/** What a native action gets when it runs for real. */
export interface ActionContext<S = unknown> {
  /** The source's session for this connection, such as its API client. */
  readonly session: S;
  readonly connection: ConnectionInfo | undefined;
  readonly source: AnySource;
  readonly log: Logger;
  readonly signal: AbortSignal;
}

/**
 * A native platform action such as `twitch.timeout()`. Actions are gated by dry-run, never run
 * on protected items, run at most once per item, and are type-checked against the source's platform.
 */
export interface Action<P extends string = string, I extends Item = Item, S = any> {
  readonly [ACTION]: true;
  /** The platform the action belongs to, or "*" for actions that work with any source. */
  readonly platform: P;
  /** A dotted name such as "twitch.timeout". */
  readonly name: string;
  /** Human-readable description for logs: "timeout viewer123 for 600s". */
  describe(event: TriggeredEvent<I>): string;
  run(event: TriggeredEvent<I>, ctx: ActionContext<S>): Promise<void>;
}

export type HandlerFn<I extends Item, Q extends Questions, C extends AnyConnection = AnyConnection> = (
  event: TriggeredEvent<I, Q, C>,
) => unknown;

export type OutcomeHandler<S extends AnySource, Q extends Questions> =
  | HandlerFn<ItemOf<S>, Q, ConnectionOf<S>>
  | Action<PlatformOf<S> | "*", ItemOf<S>, any>;

export interface SpecialEventMap<I extends Item, Q extends Questions, C extends AnyConnection = AnyConnection> {
  judged: JudgedEvent<I, Q, C>;
  review: ReviewEvent<I, Q, C>;
  action: ActionEvent<I, Q, C>;
  dropped: DroppedEvent<I, C>;
  error: ErrorEvent<I>;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface MonitorStats {
  received: number;
  judged: number;
  cached: number;
  inflight: number;
  queued: number;
  /** Connections (or fixed streams) this monitor is running for right now. */
  running: number;
  dropped: Record<DropReason, number>;
  errors: number;
  actions: Record<ActionStatus, number>;
  latencyMs: { p50: number | null; p95: number | null };
  usage: Usage;
  /** Estimated spend in USD from input tokens at the configured price. */
  estimatedCostUsd: number;
}
