import { DEFAULT_CREDENTIALS_PATH, readCredentials, writeCredentials } from "jev-events";

import { endpoints, type GoogleEndpoints } from "./endpoints.js";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

/**
 * What `jev-events auth google` asks for: read and organize mail (never delete it permanently),
 * read events and answer invites, and your address.
 */
export const DEFAULT_SCOPES = ["openid", "email", GMAIL_SCOPE, CALENDAR_SCOPE];

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

const SIGN_IN_AGAIN = "Sign in again: npx jev-events auth google";

/** The sign-in is gone for good: expired, revoked or missing. Retrying won't help. */
export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

class RefreshingAuth implements GoogleAuth {
  readonly endpoints = endpoints();
  #tokens: GoogleTokens;
  #refreshing: Promise<string> | undefined;
  readonly #persist: ((tokens: GoogleTokens) => void) | undefined;

  constructor(tokens: GoogleTokens, persist?: (tokens: GoogleTokens) => void) {
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
    if (!refreshToken) throw new GoogleAuthError(`The Google sign-in expired and there's no refresh token. ${SIGN_IN_AGAIN}`);
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
      throw new GoogleAuthError(`Google signed you out: the sign-in expired or was revoked. ${SIGN_IN_AGAIN} (apps in Testing mode are signed out after 7 days)`);
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
    this.#persist?.(this.#tokens);
    return json.access_token;
  }
}

/** Use tokens you manage yourself. `onRefresh` receives new tokens so you can store them. */
export function withTokens(tokens: GoogleTokens, onRefresh?: (tokens: GoogleTokens) => void): GoogleAuth {
  return new RefreshingAuth(tokens, onRefresh);
}

/** The account connected with `npx jev-events auth google`. Refreshed tokens are written back. */
export function fromFile(path = DEFAULT_CREDENTIALS_PATH): GoogleAuth {
  const tokens = readCredentials<GoogleTokens>("google", path);
  if (!tokens?.clientId || !(tokens.accessToken || tokens.refreshToken)) {
    throw new GoogleAuthError("Connect your Google account first: npx jev-events auth google");
  }
  return new RefreshingAuth(tokens, (next) => writeCredentials("google", { ...readCredentials<Record<string, unknown>>("google", path), ...next }, path));
}

/** GOOGLE_CLIENT_ID and GOOGLE_REFRESH_TOKEN (or GOOGLE_ACCESS_TOKEN), plus GOOGLE_CLIENT_SECRET. */
export function fromEnv(env: NodeJS.ProcessEnv = process.env): GoogleAuth {
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId || !(env.GOOGLE_REFRESH_TOKEN || env.GOOGLE_ACCESS_TOKEN)) {
    throw new Error("Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.");
  }
  return new RefreshingAuth({
    clientId,
    ...(env.GOOGLE_CLIENT_SECRET ? { clientSecret: env.GOOGLE_CLIENT_SECRET } : {}),
    ...(env.GOOGLE_REFRESH_TOKEN ? { refreshToken: env.GOOGLE_REFRESH_TOKEN } : {}),
    ...(env.GOOGLE_ACCESS_TOKEN ? { accessToken: env.GOOGLE_ACCESS_TOKEN } : {}),
  });
}
