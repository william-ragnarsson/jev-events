import { GoogleAuthError, type GoogleAuth } from "./auth.js";

export interface GoogleRequest {
  query?: Record<string, string | number | boolean | undefined>;
  /** Sent as JSON. */
  body?: unknown;
}

const TICK_EVERY_BOX = "Sign in again and tick every box on Google's consent screen.";

interface ErrorBody {
  error?: { message?: string; status?: string; errors?: Array<{ reason?: string }>; details?: Array<{ reason?: string }> };
}

export class GoogleApiError extends Error {
  /** Google's reason, such as "notFound", "rateLimitExceeded" or "insufficientPermissions". */
  readonly reason: string | undefined;
  /**
   * True when only a new sign-in fixes it: Google refused a freshly refreshed token, or the
   * account didn't grant a permission this call needs.
   */
  readonly needsSignIn: boolean;

  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    const error = (body as ErrorBody | undefined)?.error;
    const reason = error?.errors?.[0]?.reason ?? error?.status;
    const detail = error?.message ?? (typeof body === "string" ? body.slice(0, 300) : "");
    const missingScope =
      status === 403 &&
      (reason === "insufficientPermissions" ||
        error?.details?.some((d) => d.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT") === true ||
        /insufficient authentication scopes/i.test(detail));
    let message = `Google ${method} ${path} failed (${status})${detail ? `: ${detail}` : ""}`;
    if (missingScope) message = `${message.replace(/\.?$/, ".")} ${TICK_EVERY_BOX}`;
    super(message);
    this.name = "GoogleApiError";
    this.reason = reason;
    this.needsSignIn = status === 401 || missingScope;
  }

  get rateLimited(): boolean {
    return this.status === 429 || (this.status === 403 && /rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED/.test(this.reason ?? ""));
  }
}

/**
 * Errors that will repeat for every item, so a check should stop rather than skip the item: a
 * lost sign-in, a missing permission or an API that's turned off.
 */
export function isFatal(error: unknown): boolean {
  if (error instanceof GoogleAuthError) return true;
  if (!(error instanceof GoogleApiError)) return false;
  return error.status === 401 || (error.status === 403 && !error.rateLimited);
}

/** Gmail and Calendar REST calls: bearer auth, one refresh on 401, and retries on rate limits and outages. */
export class GoogleApi {
  readonly #auth: GoogleAuth;
  readonly #retryBaseMs: number;

  constructor(auth: GoogleAuth, options: { retryBaseMs?: number } = {}) {
    this.#auth = auth;
    this.#retryBaseMs = options.retryBaseMs ?? 1_000;
  }

  gmail<T>(method: string, path: string, request?: GoogleRequest): Promise<T> {
    return this.call<T>(method, this.#auth.endpoints.gmail, path, request);
  }

  calendar<T>(method: string, path: string, request?: GoogleRequest): Promise<T> {
    return this.call<T>(method, this.#auth.endpoints.calendar, path, request);
  }

  async call<T>(method: string, base: string, path: string, { query, body }: GoogleRequest = {}): Promise<T> {
    const url = new URL(base + path);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    let refreshed = false;
    for (let retries = 0; ; ) {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${await this.#auth.token()}`,
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
      const error = new GoogleApiError(method, path, response.status, parse(text));
      if ((error.rateLimited || response.status >= 500) && retries < 3) {
        await sleep(retryDelayMs(response.headers.get("retry-after"), retries, this.#retryBaseMs));
        retries++;
        continue;
      }
      throw error;
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
