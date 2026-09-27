import type { Logger } from "jev-events";

import { SlackApiError, type SlackApi } from "./api.js";

/** What Slack wraps each event in: an `event_callback`, from Socket Mode or the Events API. */
export interface EventCallback {
  type: string;
  /** The workspace the event happened in. */
  team_id?: string;
  /** The installation the event was sent for, which differs from `team_id` in channels shared with other workspaces. */
  authorizations?: { team_id?: string | null }[];
  event_id?: string;
  event_time?: number;
  event?: { type: string; [key: string]: unknown };
}

/** The workspaces an event could be for: the installation it was sent for, and where it happened. */
export function teamsOf(payload: EventCallback): string[] {
  const teams = (payload.authorizations ?? []).map((authorization) => authorization.team_id);
  return [...new Set([...teams, payload.team_id].filter((team): team is string => typeof team === "string" && team !== ""))];
}

interface Envelope {
  type?: string;
  envelope_id?: string;
  /** On `disconnect`: "warning", "refresh_requested" or "link_disabled". */
  reason?: string;
  payload?: EventCallback;
}

export interface SocketModeOptions {
  /** Calls made with the app-level token (xapp-…). */
  api: SlackApi;
  signal: AbortSignal;
  log: Logger;
  onEvent(payload: EventCallback): void;
  /** Called when the connection can't come back, such as when Socket Mode was turned off. */
  onFatal(error: Error): void;
  /** How long to wait for Slack's hello. Default 30s. */
  helloTimeoutMs?: number;
}

/**
 * Keep a Socket Mode connection open: ask Slack for a WebSocket address, acknowledge every envelope
 * at once, swap to a fresh connection when Slack asks to, and reconnect with backoff when one drops.
 * Resolves once the first connection is ready.
 */
export function socketMode(options: SocketModeOptions): Promise<void> {
  const { api, signal, log } = options;
  const open = new Set<WebSocket>();
  /** Connections being replaced, whose closing isn't a drop. */
  const retiring = new WeakSet<WebSocket>();
  let attempt = 0;
  let reconnecting = false;

  const connect = async (): Promise<WebSocket> => {
    const { url } = await openConnection(api);
    if (signal.aborted) throw new Error("Stopped.");
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      open.add(socket);
      let ready = false;
      const timer = setTimeout(() => {
        if (ready) return;
        socket.close();
        reject(new Error("Slack didn't answer on the Socket Mode connection."));
      }, options.helloTimeoutMs ?? 30_000);

      socket.addEventListener("message", (message) => {
        let envelope: Envelope;
        try {
          envelope = JSON.parse(String(message.data)) as Envelope;
        } catch {
          return;
        }
        // Acknowledge first: Slack sends it again if it hears nothing within 3 seconds.
        if (envelope.envelope_id) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        switch (envelope.type) {
          case "hello":
            ready = true;
            attempt = 0;
            clearTimeout(timer);
            resolve(socket);
            break;
          case "disconnect":
            if (envelope.reason === "link_disabled") {
              retiring.add(socket);
              socket.close();
              options.onFatal(new Error("Socket Mode is off for this Slack app. Turn it on under Settings → Socket Mode, then try again."));
            } else {
              // Slack warns before it closes a connection, and asks for a fresh one now and then.
              replace(socket);
            }
            break;
          case "events_api":
            if (envelope.payload) options.onEvent(envelope.payload);
            break;
        }
      });

      socket.addEventListener("close", () => {
        open.delete(socket);
        clearTimeout(timer);
        if (!ready) {
          reject(new Error("Slack closed the Socket Mode connection before it was ready."));
          return;
        }
        if (retiring.has(socket) || signal.aborted) return;
        log.info("slack: disconnected, reconnecting");
        void reconnect();
      });
    });
  };

  /** Open a new connection, then close the old one, so no event falls in between. */
  const replace = (old: WebSocket) => {
    if (retiring.has(old)) return;
    retiring.add(old);
    connect().then(
      () => old.close(),
      (error: unknown) => {
        log.warn(`slack: couldn't refresh the connection (${(error as Error).message}), reconnecting`);
        old.close();
        void reconnect();
      },
    );
  };

  const reconnect = async () => {
    if (reconnecting) return;
    reconnecting = true;
    try {
      while (!signal.aborted) {
        // Right away the first time, since Slack drops connections routinely; then back off.
        const delay = attempt === 0 ? 0 : Math.min(30_000, 1_000 * 2 ** (attempt - 1));
        attempt++;
        if (delay > 0) await sleep(delay, signal);
        if (signal.aborted) return;
        try {
          await connect();
          return;
        } catch (error) {
          if (isSocketFatal(error)) {
            options.onFatal(error as Error);
            return;
          }
          log.warn(`slack: couldn't reconnect (${(error as Error).message}), trying again`);
        }
      }
    } finally {
      reconnecting = false;
    }
  };

  signal.addEventListener(
    "abort",
    () => {
      for (const socket of open) {
        retiring.add(socket);
        socket.close();
      }
    },
    { once: true },
  );
  return connect().then(() => undefined);
}

/** Ask Slack for a Socket Mode address, with errors that say which token to fix. */
async function openConnection(api: SlackApi): Promise<{ url: string }> {
  try {
    return await api.call<{ url: string }>("apps.connections.open");
  } catch (error) {
    if (!(error instanceof SlackApiError)) throw error;
    if (error.code === "not_allowed_token_type") {
      throw new SocketModeError("Socket Mode needs the app-level token (xapp-…), from Basic Information → App-Level Tokens, not the xoxb- token.");
    }
    if (error.code === "missing_scope") {
      throw new SocketModeError("The app-level token lacks the connections:write scope. Make a new one under Basic Information → App-Level Tokens with that scope.");
    }
    if (error.signedOut) throw new SocketModeError(`Slack refused the app-level token (${error.code}): it was revoked or isn't valid.`);
    throw error;
  }
}

/** The app-level token doesn't work, so the workspace has to be connected again with a good one. Retrying won't help. */
export class SocketModeError extends Error {
  readonly needsSignIn = true;

  constructor(message: string) {
    super(message);
    this.name = "SocketModeError";
  }
}

function isSocketFatal(error: unknown): boolean {
  return error instanceof SocketModeError;
}

export interface SharedSocketOptions {
  /** The app-level token (xapp-…). Everything using the same one shares a single connection. */
  appToken: string;
  /** Calls made with the app-level token, used if this opens the connection. */
  api: SlackApi;
  /** The workspace whose events this wants. */
  teamId: string;
  /** Aborting it stops the events; the connection closes once nothing else uses it. */
  signal: AbortSignal;
  log: Logger;
  onEvent(payload: EventCallback): void;
  onFatal(error: Error): void;
  helloTimeoutMs?: number;
}

interface Subscriber {
  readonly teamId: string;
  readonly log: Logger;
  onEvent(payload: EventCallback): void;
  onFatal(error: Error): void;
}

interface Hub {
  readonly subscribers: Set<Subscriber>;
  readonly ready: Promise<void>;
  close(): void;
}

const hubs = new Map<string, Hub>();

/**
 * Socket Mode events for one workspace, over a connection shared by everything with the same
 * app-level token. Slack spreads an app's events across all its open connections, so two separate
 * connections would each miss some; the shared one hands each event to the monitors reading that
 * workspace. Resolves once the connection is ready.
 */
export async function sharedSocket(options: SharedSocketOptions): Promise<void> {
  const { appToken, signal } = options;
  if (signal.aborted) return;
  const hub = hubs.get(appToken) ?? openHub(options);
  const subscriber: Subscriber = { teamId: options.teamId, log: options.log, onEvent: options.onEvent, onFatal: options.onFatal };
  hub.subscribers.add(subscriber);
  const leave = () => {
    hub.subscribers.delete(subscriber);
    if (hub.subscribers.size === 0) hub.close();
  };
  signal.addEventListener("abort", leave, { once: true });
  try {
    await hub.ready;
  } catch (error) {
    signal.removeEventListener("abort", leave);
    hub.subscribers.delete(subscriber);
    if (!signal.aborted) throw error;
  }
}

function openHub(options: SharedSocketOptions): Hub {
  const subscribers = new Set<Subscriber>();
  const controller = new AbortController();
  const unclaimed = new Set<string>();
  // Log through whichever monitor still uses the connection.
  const via =
    (level: keyof Logger) =>
    (message: string, ...args: unknown[]) =>
      ([...subscribers][0]?.log ?? options.log)[level](message, ...args);
  const log: Logger = { debug: via("debug"), info: via("info"), warn: via("warn"), error: via("error") };
  const close = () => {
    if (hubs.get(options.appToken) === hub) hubs.delete(options.appToken);
    controller.abort();
  };
  const ready = socketMode({
    api: options.api,
    signal: controller.signal,
    log,
    ...(options.helloTimeoutMs !== undefined ? { helloTimeoutMs: options.helloTimeoutMs } : {}),
    onEvent: (payload) => {
      const teams = teamsOf(payload);
      const wanting = [...subscribers].filter((subscriber) => teams.length === 0 || teams.includes(subscriber.teamId));
      for (const subscriber of wanting) subscriber.onEvent(payload);
      const team = teams[0];
      if (wanting.length === 0 && team && !unclaimed.has(team)) {
        unclaimed.add(team);
        log.warn(`slack: events are coming in from workspace ${team}, which no monitor here reads. Connect it, or leave them be.`);
      }
    },
    onFatal: (error) => {
      close();
      const told = [...subscribers];
      subscribers.clear();
      for (const subscriber of told) subscriber.onFatal(error);
    },
  });
  const hub: Hub = { subscribers, ready, close };
  hubs.set(options.appToken, hub);
  ready.catch(() => close());
  return hub;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
