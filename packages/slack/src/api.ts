import { SlackAuthError } from "./auth.js";
import { apiUrl } from "./endpoints.js";

/** Method arguments. Objects and arrays are sent as JSON, the way Slack expects `blocks` and the like. */
export type SlackParams = Record<string, string | number | boolean | object | undefined>;

export interface SlackResponse {
  ok: boolean;
  error?: string;
  /** With `missing_scope`: the scope the method needs. */
  needed?: string;
  response_metadata?: { next_cursor?: string };
}

/** Errors meaning the tokens no longer work. */
const SIGNED_OUT = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"]);

const HINTS: Record<string, string> = {
  not_in_channel: "the app isn't in that channel. In Slack, type /invite @<your app> in it",
  channel_not_found: "there's no such channel, or the app can't see it",
  is_archived: "the channel is archived",
  msg_too_long: "the message is too long",
  ratelimited: "Slack is rate limiting the app",
};

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    /** Slack's error code, such as "channel_not_found" or "missing_scope". */
    readonly code: string,
    /** With `missing_scope`: the scope the method needs. */
    readonly needed?: string,
  ) {
    super(describe(method, code, needed));
    this.name = "SlackApiError";
  }

  /** The tokens were revoked or are invalid. */
  get signedOut(): boolean {
    return SIGNED_OUT.has(this.code);
  }

  /** The workspace has to be connected again, so runtimes stop reading it until then. */
  get needsSignIn(): boolean {
    return this.signedOut;
  }
}

function describe(method: string, code: string, needed: string | undefined): string {
  if (SIGNED_OUT.has(code)) return `Slack signed this workspace out (${code}): the token was revoked or isn't valid.`;
  if (code === "missing_scope") {
    return `Slack ${method} failed: the app lacks the ${needed ?? "needed"} scope. Add it under OAuth & Permissions → Scopes, then reinstall the app to the workspace.`;
  }
  const hint = HINTS[code];
  return `Slack ${method} failed: ${code}${hint ? ` (${hint})` : ""}.`;
}

/** Errors that repeat on every call, so a source should stop: lost tokens or a missing scope. */
export function isFatal(error: unknown): boolean {
  if (error instanceof SlackAuthError) return true;
  return error instanceof SlackApiError && (error.signedOut || error.code === "missing_scope");
}

export interface SlackApiOptions {
  /** Default https://slack.com/api, or JEV_SLACK_API_URL. */
  baseUrl?: string;
  /** The first retry's wait when Slack doesn't say how long to wait. Default 1s. */
  retryBaseMs?: number;
}

/** Slack Web API calls: bearer auth, `ok: false` as errors, and retries on rate limits and outages. */
export class SlackApi {
  readonly #token: string | undefined;
  readonly #baseUrl: string;
  readonly #retryBaseMs: number;

  /** `token` is left out only for methods that take none, such as `oauth.v2.access`. */
  constructor(token: string | undefined, options: SlackApiOptions = {}) {
    this.#token = token;
    this.#baseUrl = options.baseUrl ?? apiUrl();
    this.#retryBaseMs = options.retryBaseMs ?? 1_000;
  }

  async call<T extends object = SlackResponse>(method: string, params: SlackParams = {}): Promise<T & SlackResponse> {
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) body.set(name, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    for (let retries = 0; ; retries++) {
      const response = await fetch(`${this.#baseUrl}/${method}`, {
        method: "POST",
        headers: {
          ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
      const text = await response.text();
      if ((response.status === 429 || response.status >= 500) && retries < 3) {
        await sleep(retryDelayMs(response.headers.get("retry-after"), retries, this.#retryBaseMs));
        continue;
      }
      let json: SlackResponse;
      try {
        json = JSON.parse(text) as SlackResponse;
      } catch {
        throw new SlackApiError(method, response.status === 429 ? "ratelimited" : `http_${response.status}`);
      }
      if (!json.ok) throw new SlackApiError(method, json.error ?? "unknown_error", json.needed);
      return json as T & SlackResponse;
    }
  }

  /** Call a paginated method and collect `key` from every page, up to `max` entries. */
  async list<T>(method: string, key: string, params: SlackParams = {}, max = 1_000): Promise<T[]> {
    const entries: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.call<Record<string, unknown>>(method, { limit: 200, ...params, cursor });
      entries.push(...((page[key] as T[] | undefined) ?? []));
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor && entries.length < max);
    return entries.slice(0, max);
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
