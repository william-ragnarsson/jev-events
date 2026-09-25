import { createServer, type Server, type ServerResponse } from "node:http";

import type { Relay } from "./relay.js";

export interface ServerOptions {
  /** Origins allowed to read the feed from a browser. ["*"] allows any. */
  allowedOrigins: readonly string[];
  /** Feed connections at once. Default 500. */
  maxViewers?: number;
}

/**
 * GET /feed     server-sent events: "hello" (status + recent entries), then "message" and "status"
 * GET /status   the relay's status as JSON
 * GET /healthz  200 while the process is up
 */
export function createRelayServer(relay: Relay, options: ServerOptions): Server {
  const anyOrigin = options.allowedOrigins.includes("*");
  const allowed = new Set(options.allowedOrigins);

  return createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !anyOrigin && !allowed.has(origin)) return end(res, 403, "origin not allowed");
    if (origin !== undefined) {
      res.setHeader("Access-Control-Allow-Origin", anyOrigin ? "*" : origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" });
      return res.end();
    }
    if (req.method !== "GET") return end(res, 405, "method not allowed");

    const { pathname } = new URL(req.url ?? "/", "http://relay");
    switch (pathname) {
      case "/healthz":
        return end(res, 200, "ok");
      case "/status":
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify(relay.status()));
      case "/feed": {
        if (relay.watching >= (options.maxViewers ?? 500)) {
          res.setHeader("Retry-After", "30");
          return end(res, 503, "the feed is full, try again soon");
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write("retry: 5000\n\n");
        const unsubscribe = relay.subscribe({
          send(event, data) {
            // A viewer this far behind is gone; let them reconnect instead of buffering forever.
            if (res.writableLength > 1_000_000) throw new Error("viewer is not reading");
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          },
        });
        const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
        const close = () => {
          clearInterval(ping);
          unsubscribe();
        };
        req.on("close", close);
        res.on("error", close);
        return;
      }
      default:
        return end(res, 404, "not found");
    }
  });
}

function end(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}
