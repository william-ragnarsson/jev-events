import { SignInError, toConnection, type Connection } from "jev-events";

import { endpoints, type TwitchEndpoints } from "./endpoints.js";

/**
 * What sign-in asks for by default: read and send chat, and the moderation the actions do. To act
 * in someone else's channel, the account also has to be a moderator there (`/mod <account>`).
 */
export const DEFAULT_SCOPES = [
  "user:read:chat",
  "user:write:chat",
  "moderator:manage:banned_users",
  "moderator:manage:chat_messages",
  "moderator:manage:warnings",
  "clips:edit",
];

export interface TwitchTokens {
  clientId: string;
  /** Only for Confidential apps. Public apps renew tokens without one. */
  clientSecret?: string;
  /** Optional when there's a refresh token; one is fetched on first use. */
  accessToken?: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
}

export interface TwitchIdentity {
  userId: string;
  login: string;
  scopes: string[];
}

export interface TwitchAuth {
  readonly clientId: string;
  readonly endpoints: TwitchEndpoints;
  /** A valid access token, renewed shortly before it expires. */
  token(): Promise<string>;
  /** Renew now, such as after a 401. */
  refresh(): Promise<string>;
  /** Who the token belongs to and what it allows: asked of Twitch once, then remembered. */
  identity(): Promise<TwitchIdentity>;
  /** Ask Twitch whether the token is still valid. Twitch wants apps to do this at start and every hour. */
  validate(): Promise<TwitchIdentity>;
}

/** The sign-in is gone for good: revoked, expired or missing. Retrying won't help; the account has to sign in again. */
export class TwitchAuthError extends SignInError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TwitchAuthError";
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  message?: string;
}

class RefreshingAuth implements TwitchAuth {
  readonly endpoints = endpoints();
  #tokens: TwitchTokens;
  #identity: Promise<TwitchIdentity> | undefined;
  #refreshing: Promise<string> | undefined;
  readonly #persist: ((tokens: TwitchTokens) => void | Promise<void>) | undefined;

  constructor(tokens: TwitchTokens, persist?: (tokens: TwitchTokens) => void | Promise<void>) {
    if (!tokens.clientId || !(tokens.accessToken || tokens.refreshToken)) {
      throw new Error("Twitch auth needs a clientId and an access or refresh token.");
    }
    this.#tokens = { ...tokens };
    this.#persist = persist;
  }

  get clientId(): string {
    return this.#tokens.clientId;
  }

  async token(): Promise<string> {
    const { accessToken, expiresAt, refreshToken } = this.#tokens;
    if (!accessToken) return this.refresh();
    if (expiresAt !== undefined && refreshToken && expiresAt - Date.now() < 60_000) return this.refresh();
    return accessToken;
  }

  refresh(): Promise<string> {
    this.#refreshing ??= this.#doRefresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #doRefresh(): Promise<string> {
    const { clientId, clientSecret, refreshToken } = this.#tokens;
    if (!refreshToken) throw new TwitchAuthError("The Twitch sign-in expired and there's no refresh token to renew it.");
    const response = await fetch(`${this.endpoints.id}/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      }),
    });
    const json = (await response.json().catch(() => ({}))) as TokenResponse;
    // Missing for a Confidential app, or wrong: signing in again won't fix either.
    if (/client secret/i.test(json.message ?? "")) {
      throw new Error(
        `Twitch wouldn't renew the token (${json.message}): check the app's client secret in TWITCH_CLIENT_SECRET, or pass twitch.app({ clientSecret }).`,
      );
    }
    if (/client/i.test(json.message ?? "")) {
      throw new Error(`Twitch doesn't accept the app's client ID (${json.message}). Check TWITCH_CLIENT_ID.`);
    }
    if (response.status === 400 || response.status === 401) {
      throw new TwitchAuthError(
        `Twitch signed this account out (${json.message ?? response.status}): the sign-in was revoked or expired, or its refresh token was already used.`,
      );
    }
    if (!response.ok || !json.access_token) {
      throw new Error(`Couldn't renew the Twitch token (${response.status}${json.message ? `: ${json.message}` : ""}).`);
    }
    this.#tokens = {
      ...this.#tokens,
      accessToken: json.access_token,
      ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
      ...(json.expires_in ? { expiresAt: Date.now() + json.expires_in * 1000 } : {}),
    };
    await this.#persist?.(this.#tokens);
    return json.access_token;
  }

  identity(): Promise<TwitchIdentity> {
    this.#identity ??= this.#check().catch((error: unknown) => {
      this.#identity = undefined;
      throw error;
    });
    return this.#identity;
  }

  async validate(): Promise<TwitchIdentity> {
    const identity = await this.#check();
    this.#identity = Promise.resolve(identity);
    return identity;
  }

  async #check(retried = false): Promise<TwitchIdentity> {
    const response = await fetch(`${this.endpoints.id}/validate`, { headers: { Authorization: `OAuth ${await this.token()}` } });
    if (response.status === 401) {
      if (!retried && this.#tokens.refreshToken) {
        await this.refresh();
        return this.#check(true);
      }
      throw new TwitchAuthError("Twitch signed this account out: its token was revoked or expired.");
    }
    if (!response.ok) throw new Error(`Couldn't check the Twitch token (${response.status}).`);
    const json = (await response.json()) as { client_id?: string; user_id?: string; login?: string; scopes?: string[] | null; expires_in?: number };
    if (!json.user_id || !json.login) {
      throw new TwitchAuthError("That's an app access token, which can't read chat. Jev Events needs an account's token: sign in with the account.");
    }
    if (json.client_id && json.client_id !== this.clientId) {
      throw new Error(`The Twitch token was made for another app (client ID ${json.client_id}), not ${this.clientId}. Use the client ID it was made with.`);
    }
    if (this.#tokens.expiresAt === undefined && json.expires_in) this.#tokens.expiresAt = Date.now() + json.expires_in * 1000;
    return { userId: json.user_id, login: json.login, scopes: json.scopes ?? [] };
  }
}

/**
 * Use tokens you manage yourself, outside a monitor: `onRefresh` receives renewed tokens so you can
 * store them. Sources read their tokens from the connection instead.
 */
export function withTokens(tokens: TwitchTokens, onRefresh?: (tokens: TwitchTokens) => void | Promise<void>): TwitchAuth {
  return new RefreshingAuth(tokens, onRefresh);
}

/**
 * One account of your own from the environment: TWITCH_CLIENT_ID and TWITCH_ACCESS_TOKEN, plus
 * TWITCH_REFRESH_TOKEN to renew it (and TWITCH_CLIENT_SECRET for a Confidential app). Pass it where
 * a monitor starts, such as `start({ connections: [twitch.fromEnv()] })`.
 *
 * A Public app's refresh token works once, so after the first renewal the one in your environment
 * is spent and the next process can't renew. For a server, use a Confidential app, or connect the
 * account with `npx jev-events auth twitch`, which saves renewed tokens.
 */
export function fromEnv(env: NodeJS.ProcessEnv = process.env): Connection {
  const clientId = env.TWITCH_CLIENT_ID;
  if (!clientId || !(env.TWITCH_ACCESS_TOKEN || env.TWITCH_REFRESH_TOKEN)) {
    throw new Error("Set TWITCH_CLIENT_ID and TWITCH_ACCESS_TOKEN, plus TWITCH_REFRESH_TOKEN to renew it.");
  }
  return toConnection("twitch", {
    account: "env",
    label: env.TWITCH_ACCESS_TOKEN ? "TWITCH_ACCESS_TOKEN" : "TWITCH_REFRESH_TOKEN",
    credentials: {
      clientId,
      ...(env.TWITCH_CLIENT_SECRET ? { clientSecret: env.TWITCH_CLIENT_SECRET } : {}),
      ...(env.TWITCH_ACCESS_TOKEN ? { accessToken: env.TWITCH_ACCESS_TOKEN } : {}),
      ...(env.TWITCH_REFRESH_TOKEN ? { refreshToken: env.TWITCH_REFRESH_TOKEN } : {}),
    },
  });
}
