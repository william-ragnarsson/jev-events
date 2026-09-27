import { createHash, timingSafeEqual } from "node:crypto";

import { connectionInfo, type App, type Connection, type ConnectionInfo } from "../connection.js";
import { createLogger, type Logger, type LogLevel } from "../logger.js";
import { coreOf, type JevMonitor, type Monitor } from "../monitor/index.js";
import { deliveryOf, message, Run, type RunHost, type RunMode } from "../monitor/run.js";
import { storeKey, type Store } from "../store/types.js";
import type { ErrorPhase, Item, MonitorStats, PushContext } from "../types.js";
import { bearer, json } from "./http.js";
import { Limiter, Scheduler, type RateOptions } from "./scheduler.js";
import { connectUrl, finishSignIn, startSignIn, type ConnectOptions, type SignInHost, type SignInOptions } from "./signin.js";

export type { ConnectOptions, SignInOptions } from "./signin.js";

export interface RuntimeOptions {
  /** The monitors to run. A monitor belongs to one runtime. */
  monitors: readonly Monitor<any, any>[];
  /**
   * Cursors, "already seen" marks, budgets and connections with their tokens. Use `postgresStore`
   * in production, so every request, cron run and worker shares them.
   */
  store: Store;
  /** Your OAuth apps (or bots), such as `google.app({ clientId, clientSecret })`. */
  apps?: readonly App[];
  /** Connections to save in the store before anything runs, such as ones built with `toConnection()`. */
  connections?: readonly Connection[];
  /**
   * The public URL where `handle` is mounted, such as "https://example.com/api/jev". Sign-in
   * links send people back to `<baseUrl>/callback/<integration>`. Defaults to `JEV_EVENTS_URL`.
   */
  baseUrl?: string;
  /** What your scheduler sends as `Authorization: Bearer <secret>` to the cron route. Defaults to `CRON_SECRET`. */
  cronSecret?: string;
  /**
   * Keeps a serverless function alive after the response, such as `waitUntil` from
   * `@vercel/functions` or `after` from `next/server`. Without it, the webhook route judges
   * before it responds.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Requests to Jev across every monitor. Default 18 per second and 16 at once. */
  rate?: RateOptions;
  log?: Logger | LogLevel;
  /** Turns on the /connect/<integration> route for people signed in to your product. */
  signIn?: SignInOptions;
  /** How long one cron request may take. Default 50 seconds; keep it under your platform's limit. */
  maxDurationMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

/** What one run of the cron route did. */
export interface CheckResult {
  /** Connections (or fixed streams) that were checked. */
  checked: number;
  /** Ones that weren't due yet, were being checked somewhere else, or were left for lack of time. */
  skipped: number;
  /** Ones whose check failed. Each failure is also an `error` event. */
  failed: number;
  /** What each monitor received, judged and got wrong during this run. */
  monitors: Record<string, { received: number; judged: number; errors: number }>;
}

export interface Runtime {
  readonly store: Store;
  /**
   * Run as an always-on worker: connect live streams, check polling sources every `every`, and
   * pick up new connections as they're saved. Needed for chat streams such as Twitch and Discord.
   */
  start(): Promise<void>;
  /** Stop every monitor, wait for work in flight, and save the store. */
  stop(): Promise<void>;
  /**
   * The web handler for /cron, /webhook/<integration>, /callback/<integration> and
   * /connect/<integration>. Mount it on a catch-all route, such as `app/api/jev/[...path]/route.ts`
   * with `export const GET = jev.handle; export const POST = jev.handle;`.
   */
  readonly handle: (request: Request) => Promise<Response>;
  /** Check every polling monitor once for each connection that is due. What the cron route runs. */
  check(): Promise<CheckResult>;
  /** Where to send someone to connect an account. Redirect them there from your settings page. */
  connectUrl(integration: string, options?: ConnectOptions): Promise<string>;
  /** Save a connection, such as one built with `toConnection()` from tokens you already have. */
  connect(connection: Connection): Promise<void>;
  /** Stop reading a connection and forget it, with its cursors. */
  disconnect(id: string): Promise<void>;
  /** Stats per monitor id. */
  stats(): Record<string, MonitorStats>;
}

/**
 * Run monitors for your users. The same runtime serves a web app (webhook, cron and sign-in
 * routes through `handle`) and an always-on worker (`start()`); state lives in the store, so
 * both can run side by side.
 *
 * @example
 * ```ts
 * export const jev = runtime({
 *   monitors: [invites],
 *   store: postgresStore(pool),
 *   apps: [google.app({ clientId, clientSecret })],
 * });
 * // app/api/jev/[...path]/route.ts
 * export const GET = jev.handle;
 * export const POST = jev.handle;
 * ```
 */
export function runtime(options: RuntimeOptions): Runtime {
  return new JevRuntime(options);
}

/** One monitor reading one connection (or its fixed stream) in a worker. */
interface Slot {
  readonly core: JevMonitor;
  /** The connection id, or "-" for a fixed stream. */
  readonly key: string;
  readonly mode: RunMode;
  connection: Connection | undefined;
  run: Run | undefined;
  failures: number;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  wake: (() => void) | undefined;
  loop: Promise<void> | undefined;
  stopped: boolean;
}

const STOPPED = "A stopped runtime can't be restarted. Create a new one with runtime().";
/** How often a worker looks for new, changed and removed connections. */
const RECONCILE_MS = 30_000;
/** A stream that stayed up this long starts its backoff over. */
const HEALTHY_MS = 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const CRON_CONCURRENCY = 4;
const TIMEOUT: unique symbol = Symbol("timeout");

export class JevRuntime implements Runtime {
  readonly store: Store;
  readonly log: Logger;
  readonly scheduler: Scheduler;
  readonly handle: (request: Request) => Promise<Response>;

  readonly #options: RuntimeOptions;
  readonly #cores: JevMonitor[];
  readonly #solo: boolean;
  readonly #now: () => number;
  readonly #host: RunHost;
  readonly #signIn: SignInHost;
  readonly #slots = new Map<string, Slot>();
  readonly #warned = new Set<string>();
  #status: "idle" | "starting" | "running" | "stopped" = "idle";
  #once = false;
  #interval: ReturnType<typeof setInterval> | undefined;
  #reconciling: Promise<void> | undefined;
  #prepared: Promise<void> | undefined;
  #starting: Promise<void> | undefined;
  #stopping: Promise<void> | undefined;

  constructor(options: RuntimeOptions, internal: { solo?: boolean } = {}) {
    if (!options?.store) throw new TypeError("runtime() needs a store, such as postgresStore(pool) or fileStore().");
    if (!Array.isArray(options.monitors)) throw new TypeError("runtime() needs monitors: [monitor({ ... })].");
    this.#options = options;
    this.#solo = internal.solo ?? false;
    this.#now = options.now ?? Date.now;
    this.store = options.store;
    this.log = typeof options.log === "object" ? options.log : createLogger(options.log ?? "info");

    const cores = options.monitors.map(coreOf);
    const ids = new Set<string>();
    for (const core of cores) {
      if (ids.has(core.id)) {
        throw new Error(`Two monitors have the id "${core.id}". Give one of them its own id with monitor({ id: … }).`);
      }
      ids.add(core.id);
    }
    for (const core of cores) core.adopt(this);
    this.#cores = cores;

    this.scheduler = new Scheduler(new Limiter(options.rate, this.#now), this.#now);
    const app = (integration: string | undefined) =>
      integration === undefined ? undefined : options.apps?.find((a) => a.integration === integration);
    this.#host = {
      store: this.store,
      scheduler: this.scheduler,
      app,
      failed: (run, error, restart) => this.#failed(run, error, restart),
    };
    this.#signIn = {
      store: this.store,
      // An empty JEV_EVENTS_URL counts as unset, so sign-in links fall back to where the route is mounted.
      baseUrl: (options.baseUrl ?? process.env.JEV_EVENTS_URL)?.trim() || undefined,
      log: this.log,
      app,
      connect: (connection) => this.connect(connection),
    };
    this.handle = (request) => this.#handle(request);
  }

  // -------------------------------------------------------------------------
  // Worker
  // -------------------------------------------------------------------------

  start(): Promise<void> {
    if (this.#status === "stopped") return Promise.reject(new Error(STOPPED));
    this.#starting ??= this.#start().catch((error: unknown) => {
      this.#starting = undefined;
      throw error;
    });
    return this.#starting;
  }

  async #start(): Promise<void> {
    this.#status = "starting";
    try {
      for (const core of this.#cores) core.checkArmed();
      await this.#prepare();
      this.#status = "running";
      await this.#reconcile(true);
    } catch (error) {
      if (!this.#stopped) {
        this.#clear();
        this.#status = "idle";
      }
      throw error;
    }
    const polls = this.#cores.some((core) => core.source.integration && deliveryOf(core.source) !== "push");
    if (polls && !this.#stopped) {
      this.#interval = setInterval(() => {
        this.#reconcile(false).catch((error: unknown) => this.log.warn("couldn't read connections:", error));
      }, RECONCILE_MS);
    }
  }

  /** Read through a getter, since `stop()` can run while `start()` awaits. */
  get #stopped(): boolean {
    return this.#status === "stopped";
  }

  /** Read every monitor once: check each connection, or read a finite stream to its end. */
  async runOnce(): Promise<void> {
    if (this.#status === "stopped") throw new Error(STOPPED);
    this.#once = true;
    this.#status = "running";
    for (const core of this.#cores) core.checkArmed();
    await this.#prepare();
    const work: Promise<void>[] = [];
    for (const core of this.#cores) {
      const mode = deliveryOf(core.source);
      if (mode === "push") continue;
      const integration = core.source.integration;
      const targets: Array<Connection | undefined> = integration ? await this.#active(integration) : [undefined];
      if (integration && targets.length === 0) this.#noConnections(integration);
      for (const connection of targets) work.push(this.#readOnce(core, connection, mode));
    }
    await Promise.all(work);
  }

  async #readOnce(core: JevMonitor, connection: Connection | undefined, mode: RunMode): Promise<void> {
    const run = this.#newRun(core, connection, mode);
    if (mode === "check") {
      await run.check();
      return run.idle();
    }
    try {
      await run.start();
    } catch (error) {
      // A fixed stream that can't connect is the whole job failing; one account failing isn't.
      if (!connection) {
        void run.stop();
        throw error;
      }
      run.fail(error, { fatal: true });
      return;
    }
    await run.ended();
  }

  /** Stop reading without stopping the monitors. */
  async halt(): Promise<void> {
    this.#status = "stopped";
    const slots = [...this.#slots.values()];
    this.#clear();
    await Promise.allSettled(slots.flatMap((slot) => [slot.run?.stop(), slot.loop]));
    this.scheduler.stop();
  }

  stop(): Promise<void> {
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    await this.halt();
    await Promise.allSettled(this.#cores.map((core) => core.stop()));
    try {
      await this.store.flush?.();
    } catch (error) {
      this.log.warn("couldn't save the store:", error);
    }
  }

  /** Drop every slot and the reconcile timer. */
  #clear(): void {
    if (this.#interval) clearInterval(this.#interval);
    this.#interval = undefined;
    for (const slot of [...this.#slots.values()]) this.#drop(slot);
  }

  #prepare(): Promise<void> {
    this.#prepared ??= (async () => {
      for (const connection of this.#options.connections ?? []) await this.store.connections.save(connection);
      // Fails fast when TYPESAFE_API_KEY is missing, instead of on the first item.
      for (const core of this.#cores) core.client();
    })().catch((error: unknown) => {
      this.#prepared = undefined;
      throw error;
    });
    return this.#prepared;
  }

  /** Start runs for new connections, stop runs for removed ones, and restart changed ones. */
  #reconcile(initial: boolean): Promise<void> {
    if (this.#reconciling) return this.#reconciling;
    this.#reconciling = this.#reconcileNow(initial).finally(() => {
      this.#reconciling = undefined;
    });
    return this.#reconciling;
  }

  async #reconcileNow(initial: boolean): Promise<void> {
    const launches: Promise<void>[] = [];
    const listings = new Map<string, Promise<Connection[]>>();
    for (const core of this.#cores) {
      if (this.#status !== "running") return;
      if (core.stopped) {
        for (const slot of this.#slotsOf(core)) this.#drop(slot);
        continue;
      }
      const mode = deliveryOf(core.source);
      const integration = core.source.integration;
      if (mode === "push") {
        this.#warnOnce(
          `push:${core.id}`,
          `${core.id} only receives webhooks, so the worker has nothing to read. Mount jev.handle in your web app ` +
            `so the platform can reach /webhook/${integration ?? core.id}.`,
        );
        continue;
      }
      if (!integration) {
        this.#ensure(core, undefined, mode, launches, initial);
        continue;
      }
      let listing = listings.get(integration);
      if (!listing) listings.set(integration, (listing = this.#active(integration)));
      const connections = await listing;
      if (this.#status !== "running") return;
      const active = new Set(connections.map((c) => c.id));
      for (const slot of this.#slotsOf(core)) if (!active.has(slot.key)) this.#drop(slot);
      if (connections.length === 0) this.#noConnections(integration);
      else this.#warned.delete(`none:${integration}`);
      for (const connection of connections) this.#ensure(core, connection, mode, launches, initial);
    }
    await Promise.all(launches);
  }

  #ensure(core: JevMonitor, connection: Connection | undefined, mode: RunMode, launches: Promise<void>[], initial: boolean): void {
    const key = connection?.id ?? "-";
    const existing = this.#slots.get(storeKey(core.id, key));
    if (existing) {
      if (!connection || !signedInAgain(existing, connection)) return;
      this.#drop(existing);
    }
    const slot: Slot = {
      core,
      key,
      mode,
      connection,
      run: undefined,
      failures: 0,
      startedAt: this.#now(),
      timer: undefined,
      wake: undefined,
      loop: undefined,
      stopped: false,
    };
    this.#slots.set(storeKey(core.id, key), slot);
    if (mode === "check") {
      slot.loop = this.#checkLoop(slot).catch((error: unknown) => this.log.error("unexpected error:", error));
      return;
    }
    const started = this.#launch(slot);
    // Starting on its own, a fixed stream that can't connect fails start(). Accounts retry instead.
    if (this.#solo && initial) launches.push(connection ? started.catch(() => {}) : started);
    else started.catch(() => {});
  }

  /** Connect a stream slot. Failures are reported and retried through `#failed`. */
  #launch(slot: Slot): Promise<void> {
    const run = this.#newRun(slot.core, slot.connection, "stream");
    slot.run = run;
    slot.startedAt = this.#now();
    return run.start().catch((error: unknown) => {
      run.fail(error, { fatal: true });
      throw error;
    });
  }

  /** A run stopped because of a fatal error: start it again with backoff, unless it can't recover. */
  #failed(run: Run, _error: unknown, restart: boolean): void {
    const slot = this.#slots.get(storeKey(run.core.id, run.key));
    if (!slot || slot.run !== run || this.#status !== "running" || this.#once) return;
    if (!restart) return this.#drop(slot);
    // A check slot's loop makes a new run on its next turn.
    if (slot.mode !== "stream") return;
    slot.failures = this.#now() - slot.startedAt >= HEALTHY_MS ? 1 : slot.failures + 1;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (slot.failures - 1));
    slot.run = undefined;
    this.log.info(`starting ${slot.core.id}${where(slot.connection)} again in ${Math.round(delay / 1000)}s`);
    slot.timer = setTimeout(() => {
      slot.timer = undefined;
      void this.#relaunch(slot);
    }, delay);
  }

  async #relaunch(slot: Slot): Promise<void> {
    if (slot.stopped || this.#status !== "running") return;
    if (slot.connection) {
      let connection: Connection | undefined;
      try {
        connection = await this.store.connections.get(slot.connection.id);
      } catch (error) {
        this.#report(slot.core, error, slot.connection);
        connection = slot.connection;
      }
      if (slot.stopped) return;
      if (!connection || !isActive(connection)) return this.#drop(slot);
      slot.connection = connection;
    }
    this.#launch(slot).catch(() => {});
  }

  async #checkLoop(slot: Slot): Promise<void> {
    const { core } = slot;
    const every = core.everyMs;
    while (!slot.stopped && !core.stopped && this.#status === "running") {
      slot.startedAt = this.#now();
      try {
        await this.#checkSlot(slot);
      } catch (error) {
        slot.failures++;
        this.#report(core, error, slot.connection);
      }
      const wait = slot.failures ? Math.max(every, Math.min(MAX_BACKOFF_MS, every * 2 ** (slot.failures - 1))) : every;
      await this.#sleep(slot, slot.startedAt + wait - this.#now());
    }
  }

  async #checkSlot(slot: Slot): Promise<void> {
    const { core } = slot;
    // Several workers can share a store. Starting on its own, the process is alone.
    const lock = storeKey("lock", "check", core.id, slot.key);
    if (!this.#solo) {
      if (!(await this.store.claim(storeKey("due", core.id, slot.key), { ttlMs: dueMs(core) }))) return;
      if (!(await this.store.claim(lock, { ttlMs: this.#maxDuration + 10_000 }))) return;
    }
    let run: Run;
    try {
      if (!slot.run || slot.run.status === "stopped") {
        // The last run stopped on an error: read the connection again, in case it changed.
        if (slot.run && slot.connection) {
          const connection = await this.store.connections.get(slot.connection.id);
          if (!connection || !isActive(connection)) return this.#drop(slot);
          slot.connection = connection;
        }
        if (slot.stopped) return;
        slot.run = this.#newRun(core, slot.connection, "check");
      }
      run = slot.run;
      const ok = await run.check();
      slot.failures = ok ? 0 : slot.failures + 1;
    } finally {
      if (!this.#solo) await this.store.delete(lock);
    }
    // Judge what came in before the next check, so a slow minute can't pile up.
    await run.idle();
  }

  #sleep(slot: Slot, ms: number): Promise<void> {
    if (ms <= 0 || slot.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        slot.timer = undefined;
        slot.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      slot.timer = timer;
      slot.wake = done;
    });
  }

  #drop(slot: Slot): void {
    slot.stopped = true;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.wake?.();
    if (slot.run) void slot.run.stop();
    const id = storeKey(slot.core.id, slot.key);
    if (this.#slots.get(id) === slot) this.#slots.delete(id);
  }

  #slotsOf(core: JevMonitor): Slot[] {
    return [...this.#slots.values()].filter((slot) => slot.core === core);
  }

  #newRun(core: JevMonitor, connection: Connection | undefined, mode: RunMode): Run {
    // Started on its own, the monitor's rate is the runtime's rate.
    return new Run(core, this.#host, connection, mode, this.#solo ? undefined : core.limiter);
  }

  // -------------------------------------------------------------------------
  // Cron
  // -------------------------------------------------------------------------

  async check(): Promise<CheckResult> {
    if (this.#status === "stopped") throw new Error(STOPPED);
    await this.#prepare();
    const deadline = this.#now() + this.#maxDuration;
    const targets: Array<{ core: JevMonitor; connection: Connection | undefined }> = [];
    const listings = new Map<string, Promise<Connection[]>>();
    for (const core of this.#cores) {
      if (core.stopped || !core.source.check) continue;
      // A worker in this process streams it already.
      if (this.#status === "running" && deliveryOf(core.source) === "stream") continue;
      const integration = core.source.integration;
      if (!integration) {
        targets.push({ core, connection: undefined });
        continue;
      }
      let listing = listings.get(integration);
      if (!listing) listings.set(integration, (listing = this.#active(integration)));
      for (const connection of await listing) targets.push({ core, connection });
    }

    const before = new Map(this.#cores.map((core) => [core, { ...core.counters }]));
    const result: CheckResult = { checked: 0, skipped: 0, failed: 0, monitors: {} };
    await pool(targets, CRON_CONCURRENCY, async ({ core, connection }) => {
      try {
        result[await this.#checkOnce(core, connection, deadline)]++;
      } catch (error) {
        result.failed++;
        this.#report(core, error, connection);
      }
    });
    for (const [core, was] of before) {
      const now = core.counters;
      result.monitors[core.id] = { received: now.received - was.received, judged: now.judged - was.judged, errors: now.errors - was.errors };
    }
    return result;
  }

  async #checkOnce(core: JevMonitor, connection: Connection | undefined, deadline: number): Promise<"checked" | "skipped" | "failed"> {
    const key = connection?.id ?? "-";
    if (this.#now() >= deadline) return "skipped";
    if (!(await this.store.claim(storeKey("due", core.id, key), { ttlMs: dueMs(core) }))) return "skipped";
    const lock = storeKey("lock", "check", core.id, key);
    if (!(await this.store.claim(lock, { ttlMs: this.#maxDuration + 10_000 }))) return "skipped";

    const run = this.#newRun(core, connection, "check");
    let locked = true;
    try {
      const ok = await within(run.check(), deadline, this.#now);
      if (ok === TIMEOUT) {
        // The check may still be reading; its lock runs out on its own.
        locked = false;
        this.#report(core, new Error(`Checking took longer than ${this.#maxDuration}ms. Raise maxDurationMs, or check less at once.`), connection);
        return "failed";
      }
      await this.store.delete(lock);
      locked = false;
      await within(run.idle(), deadline, this.#now);
      return ok ? "checked" : "failed";
    } finally {
      await run.stop();
      if (locked) await this.store.delete(lock).catch(() => {});
    }
  }

  get #maxDuration(): number {
    return this.#options.maxDurationMs ?? 50_000;
  }

  // -------------------------------------------------------------------------
  // Web routes
  // -------------------------------------------------------------------------

  async #handle(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname.replace(/\/+$/, "");
      const route = /\/(webhook|callback|connect)\/([^/]+)$/.exec(path);
      if (route) {
        const [, kind, raw = ""] = route;
        let name: string;
        try {
          name = decodeURIComponent(raw);
        } catch {
          return notFound();
        }
        if (kind === "webhook") return await this.#webhook(request, name);
        if (kind === "callback") return await finishSignIn(this.#signIn, request, name);
        return await startSignIn(this.#signIn, request, name, this.#options.signIn);
      }
      if (path.endsWith("/cron")) return await this.#cron(request);
      return notFound();
    } catch (error) {
      this.log.error("couldn't handle a request:", error);
      return json(500, { error: "Jev Events couldn't handle this request." });
    }
  }

  async #cron(request: Request): Promise<Response> {
    const secret = this.#options.cronSecret ?? process.env.CRON_SECRET;
    if (!secret) return json(500, { error: "Set CRON_SECRET so only your scheduler can run checks." });
    if (!sameSecret(bearer(request), secret)) {
      return json(401, { error: "Send Authorization: Bearer <CRON_SECRET> to run checks." });
    }
    try {
      return json(200, await this.check());
    } catch (error) {
      this.log.error("couldn't run checks:", error);
      return json(500, { error: message(error) });
    }
  }

  async #webhook(request: Request, name: string): Promise<Response> {
    const targets = this.#cores.filter(
      (core) => !core.stopped && core.source.receive && (core.source.integration === name || core.id === name),
    );
    if (targets.length === 0) return json(404, { error: `No monitor receives webhooks for "${name}".` });
    try {
      await this.#prepare();
    } catch (error) {
      this.log.error("couldn't get ready for a webhook:", error);
      return json(500, { error: "Jev Events isn't set up. Check the server logs." });
    }

    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const runs: Run[] = [];
    const reported = new WeakSet<object>();
    const responses = await Promise.all(
      targets.map(async (core) => {
        const copy = new Request(request.url, { method: request.method, headers: request.headers, ...(body ? { body } : {}) });
        try {
          return (await core.source.receive?.(copy, this.#pushContext(core, runs, reported))) ?? notFound();
        } catch (error) {
          if (!(typeof error === "object" && error !== null && reported.has(error))) this.#report(core, error, undefined);
          return json(500, { error: "Couldn't handle this webhook." });
        }
      }),
    );

    const settle = Promise.allSettled(runs.map(async (run) => (run.status === "stopped" ? undefined : run.idle()))).then(() =>
      Promise.allSettled(runs.map((run) => run.stop())),
    );
    if (this.#options.waitUntil) this.#options.waitUntil(settle);
    else await settle;
    return responses.find((response) => response.ok) ?? (responses[0] as Response);
  }

  /** What a source's `receive` gets: one run per connection for this request, opened on first use. */
  #pushContext(core: JevMonitor, ephemeral: Run[], reported: WeakSet<object>): PushContext {
    const integration = core.source.integration;
    const opened = new Map<string, { run: Run; ready: Promise<void> }>();
    const runFor = (info: ConnectionInfo | undefined) => {
      const key = info?.id ?? "-";
      let entry = opened.get(key);
      if (entry) return entry;
      const worker = this.#slots.get(storeKey(core.id, key))?.run;
      if (worker && worker.status === "active") {
        entry = { run: worker, ready: Promise.resolve() };
      } else {
        let run: Run | undefined;
        const ready = (async () => {
          let connection: Connection | undefined;
          if (info) {
            connection = await this.store.connections.get(info.id);
            if (!connection) throw new Error(`The connection ${info.label ?? info.id} doesn't exist any more.`);
          }
          run = this.#newRun(core, connection, "push");
          ephemeral.push(run);
          await run.open();
        })();
        entry = {
          get run() {
            return run as Run;
          },
          // Reported here once, however many items were waiting for it.
          ready: ready.catch((error: unknown) => {
            if (run) run.fail(error);
            else this.#report(core, error, undefined);
            if (typeof error === "object" && error !== null) reported.add(error);
            throw error;
          }),
        };
      }
      opened.set(key, entry);
      return entry;
    };

    return {
      app: this.#host.app(integration),
      log: core.log,
      connections: async () => (integration ? (await this.#active(integration)).map(connectionInfo) : []),
      emit: async (info: ConnectionInfo | undefined, item: Item) => {
        const entry = runFor(info);
        try {
          await entry.ready;
        } catch {
          // Reported once when the run couldn't open.
          return;
        }
        await entry.run.receive(item);
      },
      session: async (info: ConnectionInfo) => {
        const entry = runFor(info);
        await entry.ready;
        return entry.run.session;
      },
      fail: async (info: ConnectionInfo | undefined, error: unknown) => {
        const entry = runFor(info);
        try {
          await entry.ready;
        } catch {
          // Reported once when the run couldn't open.
          return;
        }
        if (typeof error === "object" && error !== null) {
          if (reported.has(error)) return;
          reported.add(error);
        }
        entry.run.fail(error);
      },
    };
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  async connectUrl(integration: string, options: ConnectOptions = {}): Promise<string> {
    return connectUrl(this.#signIn, integration, options);
  }

  async connect(connection: Connection): Promise<void> {
    await this.store.connections.save(connection);
    if (this.#status !== "running" || this.#once) return;
    for (const slot of [...this.#slots.values()]) if (slot.key === connection.id) this.#drop(slot);
    await this.#reconcile(false);
  }

  async disconnect(id: string): Promise<void> {
    for (const slot of [...this.#slots.values()]) if (slot.key === id) this.#drop(slot);
    await this.store.connections.delete(id);
    await Promise.all(this.#cores.map((core) => this.store.delete(storeKey("cursor", core.id, id))));
  }

  stats(): Record<string, MonitorStats> {
    return Object.fromEntries(this.#cores.map((core) => [core.id, core.stats()]));
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  async #active(integration: string): Promise<Connection[]> {
    return (await this.store.connections.list({ integration })).filter(isActive);
  }

  #noConnections(integration: string): void {
    this.#warnOnce(
      `none:${integration}`,
      this.#solo
        ? `No ${integration} connections yet. Sign in with \`npx jev-events auth ${integration}\`, or pass connections to start().`
        : `No ${integration} connections yet. Users connect through /connect/${integration}, or save one with runtime.connect().`,
    );
  }

  #warnOnce(key: string, text: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.log.warn(text);
  }

  #report(core: JevMonitor, error: unknown, connection: Connection | undefined, phase: ErrorPhase = "source"): void {
    core.counters.errors++;
    core.emit("error", { error, phase, monitor: core.id, ...(connection ? { connection: connectionInfo(connection) } : {}) });
  }
}

function isActive(connection: Connection): boolean {
  return (connection.status ?? "active") === "active";
}

/** True when the saved connection has new tokens or account facts, so its run should start over. */
function signedInAgain(slot: Slot, saved: Connection): boolean {
  const before = slot.connection;
  if (!before) return false;
  const tokens = JSON.stringify(saved.credentials);
  // A run that refreshed its own token saved it too; that's not a new sign-in.
  const known = tokens === JSON.stringify(before.credentials) || tokens === JSON.stringify(slot.run?.credentials);
  const same = saved.label === before.label && saved.userId === before.userId && JSON.stringify(saved.facts) === JSON.stringify(before.facts);
  return !known || !same;
}

/** A check counts as done for a little less than `every`, so the next one is due on time. */
function dueMs(core: JevMonitor): number {
  return Math.max(1000, Math.floor(core.everyMs * 0.9));
}

function where(connection: Connection | undefined): string {
  return connection ? ` for ${connection.label ?? connection.id}` : "";
}

function notFound(): Response {
  return json(404, {
    error: "Not found. Jev Events handles /cron, /webhook/<integration>, /callback/<integration> and /connect/<integration>.",
  });
}

function sameSecret(given: string | undefined, secret: string): boolean {
  if (given === undefined) return false;
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(given), digest(secret));
}

/** Resolves with the promise's value, or TIMEOUT once the deadline passes. */
function within<T>(promise: Promise<T>, deadline: number, now: () => number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), Math.max(0, deadline - now()));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
