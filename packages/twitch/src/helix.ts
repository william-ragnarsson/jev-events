import { TwitchAuthError, type TwitchAuth } from "./auth.js";

export type HelixMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface HelixRequest {
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
}

/** Twitch said no. `status` and `detail` say why, such as 400 and "The user specified in the user_id field may not be banned." */
export class TwitchApiError extends Error {
  readonly status: number;
  readonly body: string;
  /** Twitch's own words for what went wrong. */
  readonly detail: string;

  constructor(method: string, path: string, status: number, body: string, message?: string) {
    const detail = detailOf(body);
    super(message ?? `Twitch ${method} ${path} failed (${status}): ${detail}`);
    this.name = "TwitchApiError";
    this.status = status;
    this.body = body;
    this.detail = detail;
  }
}

function detailOf(body: string): string {
  try {
    const json = JSON.parse(body) as { message?: unknown };
    if (typeof json.message === "string" && json.message) return json.message;
  } catch {
    // Not JSON: the body is the detail.
  }
  return body;
}

const RATE_LIMIT_RETRIES = 3;

/** Twitch's Helix API as the signed-in account: renews the token once on a 401, and waits out rate limits. */
export class Helix {
  readonly auth: TwitchAuth;
  readonly #base: string;

  constructor(auth: TwitchAuth, base = auth.endpoints.helix) {
    this.auth = auth;
    this.#base = base.replace(/\/+$/, "");
  }

  async call<T = unknown>(method: HelixMethod, path: string, request: HelixRequest = {}): Promise<T> {
    const url = new URL(this.#base + path);
    for (const [key, value] of Object.entries(request.query ?? {})) if (value !== undefined) url.searchParams.set(key, value);

    let refreshed = false;
    let waits = 0;
    for (;;) {
      const response = await fetch(url, {
        method,
        headers: {
          "Client-Id": this.auth.clientId,
          Authorization: `Bearer ${await this.auth.token()}`,
          ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });

      if (response.status === 401) {
        const body = await response.text();
        const scope = /^Missing scope: (.+)$/i.exec(detailOf(body))?.[1];
        if (scope) {
          throw new TwitchApiError(method, path, 401, body, `Twitch ${method} ${path} failed: the account hasn't allowed ${scope}. Sign in again and allow it.`);
        }
        if (!refreshed) {
          refreshed = true;
          await this.auth.refresh();
          continue;
        }
        throw new TwitchAuthError(`Twitch signed this account out (${detailOf(body) || 401}): its token was revoked or expired.`);
      }

      // Out of requests for this minute: wait for the bucket to refill. Other 429s are limits on
      // what's being asked for, such as too many chat connections, and waiting won't help.
      if (response.status === 429 && response.headers.get("ratelimit-remaining") === "0" && waits < RATE_LIMIT_RETRIES) {
        waits++;
        const reset = Number(response.headers.get("ratelimit-reset")) * 1000;
        await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, Math.max(250, reset - Date.now()))));
        continue;
      }

      if (!response.ok) throw new TwitchApiError(method, path, response.status, await response.text());
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  /** The user with this login, or undefined when there's none. */
  async userByLogin(login: string): Promise<TwitchUser | undefined> {
    const { data } = await this.call<{ data: TwitchUser[] }>("GET", "/users", { query: { login } });
    return data[0];
  }
}
