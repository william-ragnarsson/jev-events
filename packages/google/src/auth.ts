import { SignInError, toConnection, type Connection } from "jev-events";

import { endpoints, type GoogleEndpoints } from "./endpoints.js";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

/**
 * What sign-in asks for by default: read and organize mail (never delete it permanently), read
 * events and answer invites, and the account's address.
 */
export const DEFAULT_SCOPES = ["openid", "email", GMAIL_SCOPE, CALENDAR_SCOPE];

/** The scope each Google source needs, by the short name `google.app({ scopes })` takes. */
export const SCOPES = {
  gmail: GMAIL_SCOPE,
  calendar: CALENDAR_SCOPE,
} as const;

export interface GoogleTokens {
  clientId: string;
  /** Google requires it for Desktop and Web clients, even with PKCE. */
  clientSecret?: string;
  /** Optional when there's a refresh token; one is fetched on first use. */
  accessToken?: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  /** The signed-in address. */
  email?: string;
  scopes?: string[];
}

export interface GoogleAuth {
  readonly clientId: string;
  readonly endpoints: GoogleEndpoints;
  /** The signed-in address, when sign-in saved it. */
  readonly email: string | undefined;
  /** A valid access token, refreshed shortly before it expires. */
  token(): Promise<string>;
  /** Refresh now, e.g. after a 401. */
  refresh(): Promise<string>;
}

/** The sign-in is gone for good: expired, revoked or missing. Retrying won't help; the account has to sign in again. */
export class GoogleAuthError extends SignInError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GoogleAuthError";
  }
}

class RefreshingAuth implements GoogleAuth {
  readonly endpoints = endpoints();
  #tokens: GoogleTokens;
  #refreshing: Promise<string> | undefined;
  readonly #persist: ((tokens: GoogleTokens) => void | Promise<void>) | undefined;

  constructor(tokens: GoogleTokens, persist?: (tokens: GoogleTokens) => void | Promise<void>) {
    if (!tokens.clientId || !(tokens.accessToken || tokens.refreshToken)) {
      throw new Error("Google auth needs a clientId and an access or refresh token.");
    }
    this.#tokens = { ...tokens };
    this.#persist = persist;
  }

  get clientId(): string {
    return this.#tokens.clientId;
  }

  get email(): string | undefined {
    return this.#tokens.email;
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
    if (!refreshToken) throw new GoogleAuthError("The Google sign-in expired and there's no refresh token to renew it.");
    const response = await fetch(this.endpoints.token, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      }),
    });
    const json = (await response.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (json.error === "invalid_grant") {
      throw new GoogleAuthError("Google signed this account out: the sign-in expired or was revoked (apps in Testing mode are signed out after 7 days).");
    }
    if (!response.ok || !json.access_token) {
      const why = typeof json.error === "string" ? ` ${json.error}` : "";
      throw new Error(`Couldn't refresh the Google token (${response.status}${why}).`);
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
}

/**
 * Use tokens you manage yourself, outside a monitor: `onRefresh` receives new tokens so you can
 * store them. Sources read their tokens from the connection instead.
 */
export function withTokens(tokens: GoogleTokens, onRefresh?: (tokens: GoogleTokens) => void | Promise<void>): GoogleAuth {
  return new RefreshingAuth(tokens, onRefresh);
}

/**
 * One account of your own from the environment: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and
 * GOOGLE_REFRESH_TOKEN (or GOOGLE_ACCESS_TOKEN). Pass it where a monitor starts, such as
 * `start({ connections: [google.fromEnv()] })`.
 */
export function fromEnv(env: NodeJS.ProcessEnv = process.env): Connection {
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId || !(env.GOOGLE_REFRESH_TOKEN || env.GOOGLE_ACCESS_TOKEN)) {
    throw new Error("Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.");
  }
  return toConnection("google", {
    account: "env",
    label: "GOOGLE_REFRESH_TOKEN",
    credentials: {
      clientId,
      ...(env.GOOGLE_CLIENT_SECRET ? { clientSecret: env.GOOGLE_CLIENT_SECRET } : {}),
      ...(env.GOOGLE_REFRESH_TOKEN ? { refreshToken: env.GOOGLE_REFRESH_TOKEN } : {}),
      ...(env.GOOGLE_ACCESS_TOKEN ? { accessToken: env.GOOGLE_ACCESS_TOKEN } : {}),
    },
  });
}
