// The Try it page's run, in the browser: it reads a Twitch chat the way `twitchChat()` does
// and asks Jev about each message through /api/try, paced like a monitor with the limits in the
// code it shows (LIMITS).

import { chatMessage, ignoredChat, parseIrcLine, type ChatMessage } from './chat.ts';
import {
  costUsd,
  LIMITS,
  RECENT,
  type TryAnswer,
  type TryError,
  type TryMessage,
  type TryQuestion,
  type TryRequest,
  type TryResult,
} from './jev.ts';

const ENDPOINT = 'wss://irc-ws.chat.twitch.tv:443';
const JOIN_TIMEOUT_MS = 10_000;
const QUIET_MS = 20_000;
const RUN_MS = 5 * 60_000;
const ROWS = 60;
const CONCURRENCY = 16;
const ERRORS_IN_A_ROW = 3;
const RECONNECTS = 3;

export type RowState =
  | { status: 'asking' }
  | { status: 'answered'; answer: TryAnswer; latencyMs: number }
  | { status: 'failed'; error: string }
  | { status: 'stopped' };

export interface Row {
  message: ChatMessage;
  state: RowState;
}

export type Phase = 'joining' | 'reading' | 'waiting' | 'stopped';

export interface RunView {
  channel: string;
  phase: Phase;
  /** What was asked, oldest first, the way a chat lists it. */
  rows: Row[];
  /** Messages read, leaving out "!commands" and bots. */
  read: number;
  answered: number;
  /** Messages not asked about, to stay under the rate. */
  skipped: number;
  /** Average time for an answer, in milliseconds. */
  latencyMs?: number;
  spentUsd: number;
  model?: string;
  /** When the run stops by itself. */
  endsAt?: number;
  /** Joined, but nobody has written anything for a while. */
  quiet: boolean;
  /** Why it stopped or is waiting. */
  note?: string;
  /** Whether it stopped because something went wrong. */
  failed: boolean;
}

interface Job {
  message: ChatMessage;
  recent: { author: string; text: string }[];
  receivedAt: number;
}

class RequestFailed extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** What the page sends /api/try about a chat message. */
export function tryMessage(message: ChatMessage): TryMessage {
  return {
    author: message.author,
    text: message.text,
    ...(message.roles.length ? { roles: message.roles } : {}),
    ...(message.firstMessage ? { firstMessage: true } : {}),
    ...(message.replyingTo ? { replyingTo: message.replyingTo } : {}),
  };
}

export interface RunOptions {
  channel: string;
  key: string;
  question: TryQuestion;
  onChange: (view: RunView) => void;
}

export class TryRun {
  #options: RunOptions;
  #view: RunView;
  #socket?: WebSocket;
  #reconnects = 0;
  #queue: Job[] = [];
  #history: { author: string; text: string }[] = [];
  #tokens: number = LIMITS.burst;
  #refilledAt = Date.now();
  #waitUntil = 0;
  #inflight = new Set<AbortController>();
  #errorsInARow = 0;
  #latencies = { total: 0, count: 0 };
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #emitting = false;

  constructor(options: RunOptions) {
    this.#options = options;
    this.#view = { channel: options.channel, phase: 'joining', rows: [], read: 0, answered: 0, skipped: 0, spentUsd: 0, quiet: false, failed: false };
  }

  get view(): RunView {
    return this.#view;
  }

  start(): void {
    this.#connect();
    this.#emit();
  }

  /** Stop reading, and cancel the questions still waiting for an answer. */
  stop(note?: string, failed = false): void {
    if (this.#view.phase === 'stopped') return;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#socket?.close();
    this.#socket = undefined;
    for (const controller of this.#inflight) controller.abort();
    this.#inflight.clear();
    this.#update({
      phase: 'stopped',
      skipped: this.#view.skipped + this.#queue.length,
      rows: this.#view.rows.map((row): Row => (row.state.status === 'asking' ? { ...row, state: { status: 'stopped' } } : row)),
      note,
      failed,
      quiet: false,
      endsAt: undefined,
    });
    this.#queue = [];
  }

  // Twitch chat -------------------------------------------------------------------------------

  #connect(): void {
    const login = this.#options.channel;
    let socket: WebSocket;
    try {
      socket = new WebSocket(ENDPOINT);
    } catch {
      return this.stop("This browser couldn't connect to Twitch chat.", true);
    }
    this.#socket = socket;
    this.#timer('join', JOIN_TIMEOUT_MS, () => this.stop(`Couldn't join #${login}. Check the name, or try again in a moment.`, true));

    socket.onopen = () => {
      socket.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      socket.send('PASS SCHMOOPIIE');
      socket.send(`NICK justinfan${Math.floor(10_000 + Math.random() * 89_999)}`);
      socket.send(`JOIN #${login}`);
    };
    socket.onmessage = (event) => {
      for (const line of String(event.data).split('\r\n')) {
        const message = parseIrcLine(line);
        if (!message) continue;
        switch (message.command) {
          case 'PING':
            socket.send(`PONG :${message.params[0] ?? 'tmi.twitch.tv'}`);
            break;
          case 'ROOMSTATE':
            this.#joined();
            break;
          case 'RECONNECT':
            socket.close();
            break;
          case 'NOTICE':
            if (message.tags['msg-id'] === 'msg_channel_suspended') this.stop(`#${login} is suspended or doesn't exist.`, true);
            break;
          case 'PRIVMSG': {
            const chat = chatMessage(message);
            if (chat && chat.text && !ignoredChat(chat)) this.#accept(chat);
            break;
          }
        }
      }
    };
    socket.onclose = () => {
      if (this.#socket !== socket || this.#view.phase === 'stopped') return;
      if (this.#reconnects >= RECONNECTS) return this.stop('Lost the connection to Twitch chat.', true);
      this.#reconnects++;
      this.#timer('reconnect', 1000 * 2 ** (this.#reconnects - 1), () => this.#connect());
    };
  }

  #joined(): void {
    this.#clear('join');
    this.#reconnects = 0;
    if (this.#view.phase !== 'joining') return;
    this.#timer('end', RUN_MS, () => this.stop('Stopped after five minutes. Start again to keep going.'));
    this.#quietIn(QUIET_MS);
    this.#update({ phase: 'reading', endsAt: Date.now() + RUN_MS });
    this.#pump();
  }

  #quietIn(ms: number): void {
    this.#timer('quiet', ms, () => this.#update({ quiet: true }));
  }

  // Pacing, as a monitor does it: the three messages before each one go with it as context, at
  // most LIMITS.maxQueue wait (the oldest go first), and any that waited LIMITS.maxLagMs are
  // skipped.

  #accept(message: ChatMessage): void {
    if (this.#view.phase === 'stopped') return;
    const recent = this.#history.slice(-RECENT);
    this.#history.push({ author: message.author, text: message.text });
    if (this.#history.length > RECENT) this.#history.shift();

    this.#quietIn(QUIET_MS);
    let skipped = this.#view.skipped;
    this.#queue.push({ message, recent, receivedAt: Date.now() });
    if (this.#queue.length > LIMITS.maxQueue) {
      this.#queue.shift();
      skipped++;
    }
    this.#update({ read: this.#view.read + 1, skipped, quiet: false });
    this.#pump();
  }

  #pump(): void {
    const { phase } = this.#view;
    if (phase === 'stopped' || phase === 'joining') return;
    const now = Date.now();
    if (now < this.#waitUntil) return this.#timer('pump', this.#waitUntil - now, () => this.#pump());
    if (phase === 'waiting') this.#update({ phase: 'reading', note: undefined });

    this.#tokens = Math.min(LIMITS.burst, this.#tokens + ((now - this.#refilledAt) / 1000) * LIMITS.perSecond);
    this.#refilledAt = now;
    let skipped = 0;
    while (this.#queue.length > 0 && this.#inflight.size < CONCURRENCY) {
      const job = this.#queue[0] as Job;
      if (now - job.receivedAt > LIMITS.maxLagMs) {
        this.#queue.shift();
        skipped++;
        continue;
      }
      if (this.#tokens < 1) {
        this.#timer('pump', ((1 - this.#tokens) / LIMITS.perSecond) * 1000, () => this.#pump());
        break;
      }
      this.#queue.shift();
      this.#tokens -= 1;
      this.#ask(job);
    }
    if (skipped) this.#update({ skipped: this.#view.skipped + skipped });
  }

  // Asking Jev -------------------------------------------------------------------------------

  #ask(job: Job): void {
    const { message, recent } = job;
    const controller = new AbortController();
    this.#inflight.add(controller);
    const row: Row = { message, state: { status: 'asking' } };
    this.#update({ rows: [...this.#view.rows, row].slice(-ROWS) });

    void fetch('/api/try', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#options.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question: this.#options.question, message: tryMessage(message), recent } satisfies TryRequest),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as TryResult | TryError | null;
        if (!response.ok || !body || 'error' in body) {
          const error = body && 'error' in body ? body : undefined;
          throw new RequestFailed(response.status, error?.error ?? `The demo's server answered ${response.status}.`, error?.retryAfterMs);
        }
        return body;
      })
      .then(
        (result) => {
          this.#errorsInARow = 0;
          this.#latencies.total += result.latencyMs;
          this.#latencies.count++;
          this.#setRow(message.id, { status: 'answered', answer: result.answer, latencyMs: result.latencyMs });
          this.#update({
            answered: this.#view.answered + 1,
            latencyMs: this.#latencies.total / this.#latencies.count,
            spentUsd: this.#view.spentUsd + costUsd(result.inputTokens),
            model: result.model,
          });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          this.#failed(message.id, error);
        },
      )
      .finally(() => {
        this.#inflight.delete(controller);
        this.#pump();
      });
  }

  #failed(id: string, error: unknown): void {
    const text = error instanceof RequestFailed ? error.message : "Couldn't reach the demo's server.";
    this.#setRow(id, { status: 'failed', error: text });
    if (error instanceof RequestFailed && (error.status === 401 || error.status === 403)) return this.stop(text, true);
    if (error instanceof RequestFailed && error.status === 429) {
      const waitMs = error.retryAfterMs ?? 5000;
      this.#waitUntil = Date.now() + waitMs;
      this.#update({ phase: 'waiting', note: `TypeSafe asked to slow down, so this waits ${Math.ceil(waitMs / 1000)} s.` });
      return;
    }
    if (++this.#errorsInARow >= ERRORS_IN_A_ROW) this.stop(`Stopped after ${ERRORS_IN_A_ROW} errors in a row. The last one: ${text}`, true);
  }

  // Bookkeeping ------------------------------------------------------------------------------

  #setRow(id: string, state: RowState): void {
    if (this.#view.phase === 'stopped' && state.status !== 'stopped') return;
    this.#update({ rows: this.#view.rows.map((row) => (row.message.id === id ? { ...row, state } : row)) });
  }

  #timer(name: string, ms: number, run: () => void): void {
    this.#clear(name);
    this.#timers.set(
      name,
      setTimeout(() => {
        this.#timers.delete(name);
        run();
      }, ms),
    );
  }

  #clear(name: string): void {
    const timer = this.#timers.get(name);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(name);
  }

  #update(patch: Partial<RunView>): void {
    this.#view = { ...this.#view, ...patch };
    this.#emit();
  }

  /** Tell the page at most ten times a second, since a busy chat sends dozens of messages. */
  #emit(): void {
    if (this.#emitting) return;
    this.#emitting = true;
    setTimeout(() => {
      this.#emitting = false;
      this.#options.onChange(this.#view);
    }, 100);
  }
}
