import { MicrosoftAuthError, type MicrosoftAuth } from "./auth.js";
import { endpoints } from "./endpoints.js";

export interface GraphRequest {
  query?: Record<string, string | number | boolean | undefined>;
  /** Sent as JSON. */
  body?: unknown;
  /** Extra `Prefer` values, such as `odata.maxpagesize=50`. Ids are always the immutable kind. */
  prefer?: string[];
}

/** A page of a Graph collection. */
export interface GraphPage<T> {
  value?: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

const ALLOW_EVERYTHING = "Sign in again and allow every permission Microsoft asks for.";

interface ErrorBody {
  error?: { code?: string; message?: string };
}

export class GraphApiError extends Error {
  /** Graph's error code, such as `ErrorItemNotFound` or `syncStateNotFound`. */
  readonly code: string | undefined;
  readonly needsSignIn: boolean;

  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    const error = (body as ErrorBody | undefined)?.error;
    const code = error?.code;
    const detail = error?.message ?? (typeof body === "string" ? body.slice(0, 300) : "");
    const missingPermission =
      status === 403 &&
      (code === "ErrorAccessDenied" ||
        code === "Authorization_RequestDenied" ||
        /missing scope|insufficient privileges|access is denied/i.test(detail));
    let message = `Microsoft ${method} ${path} failed (${status})${detail ? `: ${detail}` : ""}`;
    if (missingPermission) message = `${message.replace(/\.?$/, ".")} ${ALLOW_EVERYTHING}`;
    super(message);
    this.name = "GraphApiError";
    this.code = code;
    this.needsSignIn = status === 401 || missingPermission;
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }
}

/**
 * Errors that will repeat for every item, so a check should stop rather than skip the item: a lost
 * sign-in or a missing permission.
 */
export function isFatal(error: unknown): boolean {
  if (error instanceof MicrosoftAuthError) return true;
  if (!(error instanceof GraphApiError)) return false;
  return error.status === 401 || error.needsSignIn;
}

/** Microsoft Graph calls: bearer auth, one refresh on 401, and retries on throttling and outages. */
export class GraphApi {
  readonly #auth: MicrosoftAuth;
  readonly #retryBaseMs: number;

  constructor(auth: MicrosoftAuth, options: { retryBaseMs?: number } = {}) {
    this.#auth = auth;
    this.#retryBaseMs = options.retryBaseMs ?? 1_000;
  }

  /**
   * Call a Graph path such as `/me/messages`, or a `@odata.nextLink` or `@odata.deltaLink` Graph
   * returned. Links to anywhere but Graph are refused, so the token never leaves it.
   */
  async call<T>(method: string, pathOrLink: string, { query, body, prefer }: GraphRequest = {}): Promise<T> {
    const graph = endpoints().graph;
    const link = /^https?:\/\//i.test(pathOrLink);
    const url = new URL(link ? pathOrLink : graph + pathOrLink);
    if (link && (url.origin !== new URL(graph).origin || !url.pathname.startsWith(new URL(graph).pathname))) {
      throw new Error(`Refusing to send the Microsoft token to ${url.origin}: links must point to ${graph}.`);
    }
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const path = link ? url.pathname.slice(new URL(graph).pathname.length) || "/" : pathOrLink;
    let refreshed = false;
    for (let retries = 0; ; ) {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${await this.#auth.token()}`,
          Prefer: ['IdType="ImmutableId"', ...(prefer ?? [])].join(", "),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (response.ok) return (text ? JSON.parse(text) : undefined) as T;
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        await this.#auth.refresh();
        continue;
      }
      const error = new GraphApiError(method, path, response.status, parse(text));
      if ((error.rateLimited || response.status >= 500) && retries < 3) {
        await sleep(retryDelayMs(response.headers.get("retry-after"), retries, this.#retryBaseMs));
        retries++;
        continue;
      }
      throw error;
    }
  }

  /** Every item of a collection, following `@odata.nextLink` for up to `maxPages` pages. */
  async all<T>(path: string, request: GraphRequest = {}, maxPages = 10): Promise<T[]> {
    const items: T[] = [];
    let page = await this.call<GraphPage<T>>("GET", path, request);
    for (let pages = 1; ; pages++) {
      items.push(...(page.value ?? []));
      const next = page["@odata.nextLink"];
      if (!next || pages >= maxPages) return items;
      page = await this.call<GraphPage<T>>("GET", next, { ...(request.prefer ? { prefer: request.prefer } : {}) });
    }
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function retryDelayMs(retryAfter: string | null, retries: number, baseMs: number): number {
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000);
  return baseMs * 2 ** retries;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
