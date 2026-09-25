import type { TwitchAuth } from "./auth.js";

export class TwitchApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(method: string, path: string, status: number, body: string) {
    let detail = body;
    try {
      detail = (JSON.parse(body) as { message?: string }).message ?? body;
    } catch {
      // Not JSON.
    }
    super(`Twitch ${method} ${path} failed (${status}): ${detail}`);
    this.name = "TwitchApiError";
    this.status = status;
    this.body = body;
  }
}

export interface HelixRequest {
  query?: Record<string, string | undefined>;
  body?: unknown;
}

/** A small Helix client: auth headers, one refresh on 401, waits out 429s. */
export class Helix {
  readonly auth: TwitchAuth;
  readonly #base: string;

  constructor(auth: TwitchAuth, base = "https://api.twitch.tv/helix") {
    this.auth = auth;
    this.#base = base;
  }

  async call<T = unknown>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, request: HelixRequest = {}): Promise<T> {
    const url = new URL(this.#base + path);
    for (const [key, value] of Object.entries(request.query ?? {})) if (value !== undefined) url.searchParams.set(key, value);

    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        method,
        headers: {
          "Client-Id": this.auth.clientId,
          Authorization: `Bearer ${await this.auth.token()}`,
          ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      if (response.status === 401 && attempt === 0) {
        await this.auth.refresh();
        continue;
      }
      if (response.status === 429 && attempt < 3) {
        const reset = Number(response.headers.get("ratelimit-reset")) * 1000;
        await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, Math.max(250, reset - Date.now()))));
        continue;
      }
      if (!response.ok) throw new TwitchApiError(method, path, response.status, await response.text());
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  async userByLogin(login: string): Promise<{ id: string; login: string; display_name: string } | undefined> {
    const response = await this.call<{ data: Array<{ id: string; login: string; display_name: string }> }>("GET", "/users", {
      query: { login },
    });
    return response.data[0];
  }
}
