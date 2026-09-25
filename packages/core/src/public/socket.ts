import type { Logger } from "../logger.js";

export interface ReconnectingOptions {
  url: string | (() => string);
  signal: AbortSignal;
  log: Logger;
  label: string;
  /** Reject the first connection if not ready within this time. */
  readyTimeoutMs: number;
  onOpen?(socket: WebSocket): void;
  /** Call `ready()` once the stream is live; the first call resolves `start()`. */
  onMessage(data: string, socket: WebSocket, ready: () => void): void;
  onError?(error: Error): void;
  /** Reconnect when no message arrives for this long. */
  idleTimeoutMs?: number;
}

/**
 * Keep a WebSocket connected with exponential backoff until `signal` aborts. Resolves once the
 * first connection reports ready; rejects if that doesn't happen in time.
 */
export function reconnecting(options: ReconnectingOptions): Promise<void> {
  const { signal, log, label } = options;
  let attempt = 0;
  let everReady = false;
  let failed = false;
  let socket: WebSocket | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  return new Promise<void>((resolve, reject) => {
    const firstTimeout = setTimeout(() => {
      if (everReady) return;
      failed = true;
      socket?.close();
      reject(new Error(`Couldn't connect to ${label} within ${Math.round(options.readyTimeoutMs / 1000)}s.`));
    }, options.readyTimeoutMs);

    const ready = () => {
      attempt = 0;
      if (everReady) return;
      everReady = true;
      clearTimeout(firstTimeout);
      resolve();
    };

    const armIdle = () => {
      if (!options.idleTimeoutMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        log.warn(`${label}: no data for ${Math.round((options.idleTimeoutMs ?? 0) / 1000)}s, reconnecting`);
        socket?.close();
      }, options.idleTimeoutMs);
    };

    const connect = () => {
      if (signal.aborted) return;
      const url = typeof options.url === "function" ? options.url() : options.url;
      const current = new WebSocket(url);
      socket = current;
      current.addEventListener("open", () => {
        armIdle();
        options.onOpen?.(current);
      });
      current.addEventListener("message", (event) => {
        armIdle();
        options.onMessage(typeof event.data === "string" ? event.data : String(event.data), current, ready);
      });
      current.addEventListener("error", () => {
        options.onError?.(new Error(`${label}: connection error`));
      });
      current.addEventListener("close", () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (signal.aborted || failed || socket !== current) return;
        if (!everReady && attempt >= 2) return; // the first-connection timeout reports this
        const delay = Math.min(30_000, 1_000 * 2 ** attempt++);
        log.info(`${label}: disconnected, reconnecting in ${Math.round(delay / 1000)}s`);
        setTimeout(connect, delay);
      });
    };

    signal.addEventListener("abort", () => {
      clearTimeout(firstTimeout);
      if (idleTimer) clearTimeout(idleTimer);
      socket?.close();
      if (!everReady) reject(signal.reason);
    });
    connect();
  });
}
