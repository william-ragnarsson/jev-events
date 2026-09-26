import type { Logger } from "jev-events";

import { SlackApiError, type SlackApi } from "./api.js";

/** What Slack wraps each event in: an `event_callback`, from Socket Mode or the Events API. */
export interface EventCallback {
  type: string;
  team_id?: string;
  event_id?: string;
  event_time?: number;
  event?: { type: string; [key: string]: unknown };
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
    if (error.signedOut) {
      throw new SocketModeError(`Slack refused the app-level token (${error.code}). Connect again: npx jev-events auth slack`);
    }
    throw error;
  }
}

/** A problem with the app-level token or the app's settings, which retrying won't fix. */
export class SocketModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocketModeError";
  }
}

function isSocketFatal(error: unknown): boolean {
  return error instanceof SocketModeError;
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
