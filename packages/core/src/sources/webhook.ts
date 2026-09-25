import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { Item, Source } from "../types.js";
import { toItem, type ItemInput } from "./from.js";

export interface WebhookOptions<T = unknown> {
  /** Default 8787. Use 0 for a random free port. */
  port?: number;
  /** Default "127.0.0.1". Use "0.0.0.0" to accept requests from other machines. */
  host?: string;
  /** Default "/". */
  path?: string;
  /** Require `Authorization: Bearer <secret>`. */
  secret?: string;
  /**
   * Turn a request body into items. By default a string, `{ text }` or an array of them. Bodies are
   * parsed as JSON when the Content-Type says so or when they are a JSON object or array.
   */
  map?: (body: T) => ItemInput | readonly ItemInput[] | null | undefined;
  /** Largest accepted body. Default 1 MB. */
  maxBytes?: number;
  id?: string;
  noun?: string;
}

export interface WebhookSource extends Source<Item, "custom"> {
  /** Where to POST once started, e.g. "http://127.0.0.1:8787/". */
  readonly url: string | undefined;
}

/** Accept items over HTTP, so any service that can send a webhook becomes a stream. */
export function webhook<T = unknown>(options: WebhookOptions<T> = {}): WebhookSource {
  const path = options.path ?? "/";
  const maxBytes = options.maxBytes ?? 1_000_000;
  const map = options.map ?? ((body: T) => body as unknown as ItemInput | readonly ItemInput[]);
  let url: string | undefined;

  return {
    id: options.id ?? `custom:webhook:${path}`,
    platform: "custom",
    noun: options.noun ?? "item",
    get url() {
      return url;
    },
    start(ctx) {
      const server = createServer((request, response) => {
        void handle(request, response).catch((error: unknown) => {
          ctx.fail(error);
          reply(response, 500, { error: "internal error" });
        });
      });

      async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const requestPath = new URL(request.url ?? "/", "http://localhost").pathname;
        if (requestPath !== path) return reply(response, 404, { error: "not found" });
        if (request.method !== "POST") return reply(response, 405, { error: "use POST" });
        if (options.secret && !authorized(request.headers.authorization, options.secret)) {
          return reply(response, 401, { error: "unauthorized" });
        }
        const body = await readBody(request, maxBytes);
        if (body === undefined) return reply(response, 413, { error: `body exceeds ${maxBytes} bytes` });

        const parsed = parseBody(body, request.headers["content-type"] ?? "");
        if (!parsed.ok) return reply(response, 400, { error: "invalid JSON" });
        const mapped = map(parsed.value as T);
        const inputs = mapped == null ? [] : Array.isArray(mapped) ? mapped : [mapped as ItemInput];
        for (const input of inputs) {
          if (typeof input !== "string" && typeof input?.text !== "string") {
            return reply(response, 400, { error: 'each item needs a "text" string' });
          }
        }
        for (const input of inputs) ctx.emit(toItem(input));
        reply(response, 202, { accepted: inputs.length });
      }

      ctx.signal.addEventListener("abort", () => {
        server.close();
        server.closeAllConnections();
      });

      return new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 8787, options.host ?? "127.0.0.1", () => {
          const address = server.address();
          if (address && typeof address === "object") {
            const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
            url = `http://${host}:${address.port}${path}`;
          }
          ctx.log.info(`webhook listening on ${url}`);
          resolve();
        });
      });
    },
  };
}

function authorized(header: string | undefined, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * JSON when the Content-Type says so. Tools like `curl -d` send JSON without saying so, so a body
 * that parses as a JSON object or array is read as JSON too; anything else is plain text.
 */
function parseBody(body: string, contentType: string): { ok: true; value: unknown } | { ok: false } {
  if (contentType.includes("json")) {
    try {
      return { ok: true, value: JSON.parse(body) };
    } catch {
      return { ok: false };
    }
  }
  if (/^\s*[[{]/.test(body)) {
    try {
      return { ok: true, value: JSON.parse(body) };
    } catch {
      // Plain text that happens to start with a bracket, like "[ERROR] db down".
    }
  }
  return { ok: true, value: body };
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
