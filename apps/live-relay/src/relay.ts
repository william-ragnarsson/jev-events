import { createHmac, randomBytes } from "node:crypto";

import { estimateCostUsd, silentLogger, type DailyBudget, type JevClient, type Logger } from "jev-events";
import type { TwitchPublicChatOptions } from "jev-events/public";

import type { ChannelPicker, StreamInfo } from "./channels.js";
import { judgeChat, type Judged } from "./judge.js";

export type RelayState = "idle" | "connecting" | "live" | "budget" | "offline";

/** One labeled chat message, as the landing page receives it. */
export interface FeedEntry {
  id: string;
  /** A stable nickname such as "viewer-4821". Real names never leave the relay. */
  user: string;
  /** Null when the message was hidden for being hateful. Links and @mentions are masked. */
  text: string | null;
  /** The `kind` label, or "hateful" when hidden. */
  label: string;
  /** Probability of `label`. */
  p: number;
  /** Probability the message is hateful. */
  hateful: number;
  latencyMs: number;
  /** Answered from the copy-paste cache instead of a new request. */
  cached: boolean;
  at: number;
}

export interface RelayStatus {
  state: RelayState;
  stream: StreamInfo | null;
  /** People watching the feed right now. */
  watching: number;
  /** Messages per second arriving in the channel, and how many of those Jev labels. */
  chatPerSecond: number;
  judgedPerSecond: number;
  today: { judged: number; inputTokens: number; spendUsd: number; budgetUsed: number };
  latencyMs: { p50: number | null; p95: number | null };
  model: string | null;
  /** When the relay started reading the current channel. */
  since: number | null;
}

export interface FeedClient {
  send(event: "hello" | "message" | "status", data: unknown): void;
}

export interface RelayOptions {
  channels: ChannelPicker;
  budget: DailyBudget;
  /** Default 5 judgments per second. */
  perSecond?: number;
  /** Disconnect from Twitch this long after the last viewer leaves. Default 60 s. */
  idleDisconnectMs?: number;
  /** Move to another channel when chat is silent this long. Default 90 s. */
  quietSwitchMs?: number;
  /** Hide the text of messages at least this likely to be hateful. Default 0.5. */
  hideAt?: number;
  /** Recent entries sent to people who just arrived. Default 50. */
  bufferSize?: number;
  /** How often to check the channel and push status. Default 2 s. */
  tickMs?: number;
  usdPerMillionInputTokens?: number;
  client?: JevClient;
  chat?: TwitchPublicChatOptions;
  log?: Logger;
  /** Called with every entry sent to the feed, e.g. to record a replay. */
  onEntry?: (entry: FeedEntry) => void;
  now?: () => number;
}

type Chat = ReturnType<typeof judgeChat>;

export class Relay {
  readonly #options: RelayOptions;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #clients = new Set<FeedClient>();
  readonly #buffer: FeedEntry[] = [];
  readonly #avoid = new Map<string, number>();
  readonly #nickname = nicknames();
  readonly #recentTexts = new Map<string, number>();
  readonly #latencies: number[] = [];
  readonly #ticker: ReturnType<typeof setInterval>;

  #state: RelayState = "idle";
  #chat: Chat | undefined;
  #stream: StreamInfo | null = null;
  #since: number | null = null;
  #model: string | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #connecting: Promise<void> | undefined;
  #day = "";
  #judgedToday = 0;
  #lastReceived = 0;
  #lastJudged = 0;
  #lastTick: number;
  #lastActivity = 0;
  #chatPerSecond = 0;
  #judgedPerSecond = 0;
  #closed = false;

  constructor(options: RelayOptions) {
    this.#options = options;
    this.#log = options.log ?? silentLogger;
    this.#now = options.now ?? Date.now;
    this.#lastTick = this.#now();
    this.#ticker = setInterval(() => this.#tick(), options.tickMs ?? 2_000);
    this.#ticker.unref();
  }

  get state(): RelayState {
    return this.#state;
  }

  get watching(): number {
    return this.#clients.size;
  }

  /** Add a viewer. The relay connects on the first one; the returned function removes them. */
  subscribe(client: FeedClient): () => void {
    this.#clients.add(client);
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    if (this.#state === "idle" || this.#state === "offline") void this.#connect();
    client.send("hello", { status: this.status(), recent: this.#buffer });
    return () => {
      if (!this.#clients.delete(client) || this.#clients.size > 0 || this.#closed) return;
      this.#idleTimer = setTimeout(() => void this.#disconnect("idle"), this.#options.idleDisconnectMs ?? 60_000);
      this.#idleTimer.unref();
    };
  }

  status(): RelayStatus {
    this.#rollDay();
    const budget = this.#options.budget;
    return {
      state: this.#state,
      stream: this.#stream,
      watching: this.#clients.size,
      chatPerSecond: round(this.#chatPerSecond, 1),
      judgedPerSecond: round(this.#judgedPerSecond, 1),
      today: {
        judged: this.#judgedToday,
        inputTokens: budget.spent,
        spendUsd: round(estimateCostUsd(budget.spent, this.#options.usdPerMillionInputTokens), 4),
        budgetUsed: budget.limit === 0 ? 1 : round(Math.min(1, budget.spent / budget.limit), 3),
      },
      latencyMs: { p50: percentile(this.#latencies, 50), p95: percentile(this.#latencies, 95) },
      model: this.#model,
      since: this.#since,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#ticker);
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    await this.#connecting;
    await this.#disconnect("idle");
  }

  // -------------------------------------------------------------------------

  #connect(): Promise<void> {
    this.#connecting ??= this.#doConnect().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #doConnect(): Promise<void> {
    if (this.#closed || this.#clients.size === 0) return;
    if (this.#options.budget.exhausted) return this.#setState("budget");
    this.#setState("connecting");

    let stream: StreamInfo | undefined;
    try {
      stream = await this.#options.channels.pick(this.#avoiding());
    } catch (error) {
      this.#log.warn("couldn't pick a channel:", error);
    }
    if (!stream) return this.#retryLater();

    const chat = judgeChat(stream.channel, {
      perSecond: this.#options.perSecond ?? 5,
      budget: this.#options.budget,
      onJudged: (event) => this.#judged(event),
      ...(this.#options.client ? { client: this.#options.client } : {}),
      ...(this.#options.chat ? { chat: this.#options.chat } : {}),
      log: this.#log,
    });
    chat.on("error", (event) => this.#log.warn(`${event.phase} error on #${stream.channel}:`, event.error));
    try {
      await chat.start();
    } catch (error) {
      this.#log.warn(`couldn't join #${stream.channel}:`, error);
      this.#avoid.set(stream.channel, this.#now() + 30 * 60_000);
      await chat.stop();
      return this.#retryLater(1_000);
    }
    if (this.#closed || this.#clients.size === 0) {
      await chat.stop();
      return this.#setState("idle");
    }

    this.#chat = chat;
    this.#stream = stream;
    this.#since = this.#now();
    this.#lastActivity = this.#now();
    this.#lastReceived = 0;
    this.#lastJudged = 0;
    this.#log.info(`reading #${stream.channel}`);
    this.#setState("live");
  }

  #retryLater(ms = 60_000): void {
    this.#setState("offline");
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (this.#clients.size > 0) void this.#connect();
    }, ms);
    this.#retryTimer.unref();
  }

  async #disconnect(next: "idle" | "budget"): Promise<void> {
    const chat = this.#chat;
    this.#chat = undefined;
    this.#stream = null;
    this.#since = null;
    this.#chatPerSecond = 0;
    this.#judgedPerSecond = 0;
    if (chat) await chat.stop();
    this.#setState(next);
  }

  async #switchChannel(reason: string): Promise<void> {
    const channel = this.#stream?.channel;
    if (channel) {
      this.#log.info(`leaving #${channel}: ${reason}`);
      this.#avoid.set(channel, this.#now() + 30 * 60_000);
    }
    await this.#disconnect("idle");
    await this.#connect();
  }

  #judged(event: Judged): void {
    this.#rollDay();
    this.#judgedToday++;
    this.#model = event.model;
    if (!event.cached) {
      this.#latencies.push(event.latencyMs);
      if (this.#latencies.length > 300) this.#latencies.shift();
    }

    const hateful = event.answers.hateful.noul;
    const hidden = hateful >= (this.#options.hideAt ?? 0.5);
    const { kind } = event.answers;

    // A copy-paste flood is judged once; show it once too.
    const key = event.item.text.toLowerCase().replace(/\s+/g, " ").trim();
    const seen = this.#recentTexts.get(key);
    if (event.cached && seen !== undefined && this.#now() - seen < 10_000) return;
    this.#recentTexts.set(key, this.#now());
    if (this.#recentTexts.size > 500) this.#recentTexts.delete(this.#recentTexts.keys().next().value as string);

    const entry: FeedEntry = {
      id: event.item.id,
      user: this.#nickname(event.item.author.id),
      text: hidden ? null : scrub(event.item.text),
      label: hidden ? "hateful" : kind.choice,
      p: round(hidden ? hateful : (kind.probabilities[kind.choice] ?? kind.confidence), 3),
      hateful: round(hateful, 3),
      latencyMs: Math.round(event.latencyMs),
      cached: event.cached,
      at: this.#now(),
    };
    this.#buffer.push(entry);
    if (this.#buffer.length > (this.#options.bufferSize ?? 50)) this.#buffer.shift();
    this.#options.onEntry?.(entry);
    this.#broadcast("message", entry);
  }

  #tick(): void {
    const now = this.#now();
    const seconds = Math.max(0.001, (now - this.#lastTick) / 1000);
    this.#lastTick = now;

    const chat = this.#chat;
    if (chat && this.#state === "live") {
      const stats = chat.stats();
      const received = stats.received - this.#lastReceived;
      const judged = stats.judged - this.#lastJudged;
      this.#lastReceived = stats.received;
      this.#lastJudged = stats.judged;
      // Smooth the rates so the page doesn't flicker.
      this.#chatPerSecond = this.#chatPerSecond * 0.6 + (received / seconds) * 0.4;
      this.#judgedPerSecond = this.#judgedPerSecond * 0.6 + (judged / seconds) * 0.4;
      if (received > 0) this.#lastActivity = now;

      if (this.#options.budget.exhausted) {
        this.#log.warn("daily token budget spent; the page falls back to its replay");
        void this.#disconnect("budget");
      } else if (now - this.#lastActivity > (this.#options.quietSwitchMs ?? 90_000)) {
        void this.#switchChannel("chat went quiet");
      }
    } else if (this.#state === "budget" && !this.#options.budget.exhausted && this.#clients.size > 0) {
      void this.#connect();
    }

    if (this.#clients.size > 0) this.#broadcast("status", this.status());
  }

  #setState(state: RelayState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#broadcast("status", this.status());
  }

  #broadcast(event: "message" | "status", data: unknown): void {
    for (const client of this.#clients) {
      try {
        client.send(event, data);
      } catch (error) {
        this.#log.warn("dropping a viewer whose connection failed:", error);
        this.#clients.delete(client);
      }
    }
  }

  #avoiding(): Set<string> {
    const now = this.#now();
    for (const [channel, until] of this.#avoid) if (until < now) this.#avoid.delete(channel);
    return new Set(this.#avoid.keys());
  }

  #rollDay(): void {
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    if (day === this.#day) return;
    this.#day = day;
    this.#judgedToday = 0;
  }
}

/** Stable, meaningless nicknames. The key is random per process, so they can't be reversed. */
export function nicknames(key: Buffer = randomBytes(32)): (userId: string) => string {
  return (userId) => `viewer-${1000 + (createHmac("sha256", key).update(userId).digest().readUInt32BE(0) % 9000)}`;
}

const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|gg|tv|xyz|shop|ru|co|me|ly|app|dev|live|store)\b(?:\/\S*)?/gi;

/** Mask links and @mentions, so the page never shows a URL or anyone's name. */
export function scrub(text: string): string {
  const masked = text.replace(LINK, "[link]").replace(/@\w{2,25}/g, "@viewer");
  return masked.length > 280 ? `${masked.slice(0, 279)}…` : masked;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
