import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { json } from "../runtime/http.js";
import type { Item, Source } from "../types.js";
import { toItem, type ItemInput } from "./from.js";

export interface WebhookOptions<T = unknown> {
  /** Default 8787. Use 0 for a random free port. Only for `start()`; the web route has its own. */
  port?: number;
  /** Default "127.0.0.1". Use "0.0.0.0" to accept requests from other machines. */
  host?: string;
  /** Default "/". Only for `start()`; in a web app, POST to <jev.handle>/webhook/<monitor id>. */
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
  /**
   * The source id, which is also the monitor's id unless you give the monitor one. Default
   * "webhook", or "webhook-in" for path "/in". In a web app, POST to <jev.handle>/webhook/<monitor id>.
   */
  id?: string;
  noun?: string;
}

export interface WebhookSource extends Source<Item, "custom"> {
  /** Where to POST once started, e.g. "http://127.0.0.1:8787/". */
  readonly url: string | undefined;
}

interface Reply {
  status: number;
  body: unknown;
}

interface Incoming {
  method: string | undefined;
  authorization: string | undefined;
  contentType: string;
  /** The body as text, or undefined when it's too large. */
  read(): Promise<string | undefined>;
}

/**
 * Accept items over HTTP, so any service that can send a webhook becomes a stream. Run it as a
 * worker and it listens on its own port; pass it to `runtime()` and it answers POSTs to
 * `<jev.handle>/webhook/<monitor id>`.
 */
export function webhook<T = unknown>(options: WebhookOptions<T> = {}): WebhookSource {
  const path = options.path ?? "/";
  const maxBytes = options.maxBytes ?? 1_000_000;
  const map = options.map ?? ((body: T) => body as unknown as ItemInput | readonly ItemInput[]);
  let url: string | undefined;

  async function accept(request: Incoming, emit: (item: Item) => Promise<void>): Promise<Reply> {
    if (request.method !== "POST") return { status: 405, body: { error: "use POST" } };
    if (options.secret && !authorized(request.authorization, options.secret)) {
      return { status: 401, body: { error: "unauthorized" } };
    }
    const body = await request.read();
    if (body === undefined) return { status: 413, body: { error: `body exceeds ${maxBytes} bytes` } };

    const parsed = parseBody(body, request.contentType);
    if (!parsed.ok) return { status: 400, body: { error: "invalid JSON" } };
    const mapped = map(parsed.value as T);
    const inputs = mapped == null ? [] : Array.isArray(mapped) ? mapped : [mapped as ItemInput];
    for (const input of inputs) {
      if (typeof input !== "string" && typeof input?.text !== "string") {
        return { status: 400, body: { error: 'each item needs a "text" string' } };
      }
    }
    for (const input of inputs) await emit(toItem(input));
    return { status: 202, body: { accepted: inputs.length } };
  }

  return {
    id: options.id ?? (path === "/" ? "webhook" : `webhook${path.replace(/\/+$/, "").replace(/\//g, "-")}`),
    platform: "custom",
    noun: options.noun ?? "item",
    get url() {
      return url;
    },
    start(ctx) {
      const server = createServer((request, response) => {
        void handle(request, response).catch((error: unknown) => {
          ctx.fail(error);
          reply(response, { status: 500, body: { error: "internal error" } });
        });
      });

      async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const requestPath = new URL(request.url ?? "/", "http://localhost").pathname;
        if (requestPath !== path) return reply(response, { status: 404, body: { error: "not found" } });
        const result = await accept(
          {
            method: request.method,
            authorization: request.headers.authorization,
            contentType: request.headers["content-type"] ?? "",
            read: () => readBody(request, maxBytes),
          },
          (item) => ctx.emit(item),
        );
        reply(response, result);
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
    async receive(request, ctx) {
      const result = await accept(
        {
          method: request.method,
          authorization: request.headers.get("authorization") ?? undefined,
          contentType: request.headers.get("content-type") ?? "",
          read: () => readRequest(request, maxBytes),
        },
        (item) => ctx.emit(undefined, item),
      );
      return json(result.status, result.body);
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

async function readRequest(request: Request, maxBytes: number): Promise<string | undefined> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
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

function reply(response: ServerResponse, result: Reply): void {
  if (response.headersSent) return;
  response.writeHead(result.status, { "content-type": "application/json" });
  response.end(JSON.stringify(result.body));
}
