import { SignInError, toConnection, type Connection } from "jev-events";
import { oauthUrl } from "./endpoints.js";

/** Read, move, flag and categorize mail, and write drafts. Nothing Jev does sends mail. */
export const MAIL_SCOPE = "Mail.ReadWrite";
/** Read events and answer invites. */
export const CALENDAR_SCOPE = "Calendars.ReadWrite";
/** Read Teams chats, reply and react. Work and school accounts only. */
export const CHAT_SCOPE = "Chat.ReadWrite";
/** Who signed in, and a refresh token so the sign-in lasts. */
export const SIGN_IN_SCOPES = ["openid", "profile", "email", "offline_access", "User.Read"] as const;
/** Short names for the scopes each part of the integration needs. */
export const SCOPES = { outlook: MAIL_SCOPE, calendar: CALENDAR_SCOPE, teams: CHAT_SCOPE } as const;
export const DEFAULT_SCOPES: readonly string[] = [...SIGN_IN_SCOPES, MAIL_SCOPE, CALENDAR_SCOPE, CHAT_SCOPE];

/** Short names ("outlook", "calendar", "teams") become scope names; anything else is kept as it is. */
export function expandScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => (SCOPES as Record<string, string>)[scope] ?? scope))];
}

export interface MicrosoftTokens {
  /** The app the tokens were issued to. A refresh token only works with the app that got it. */
  clientId: string;
  /** Only for a web app's client. The CLI signs in without one. */
  clientSecret?: string;
  /** "common" for any account, or your directory's id for an app that only allows your organization. */
  tenant?: string;
  accessToken?: string;
  refreshToken?: string;
  /** When the access token expires, in epoch milliseconds. */
  expiresAt?: number;
  email?: string;
  /** The permissions asked for at sign-in, asked for again on each refresh. */
  scopes?: string[];
}

export interface MicrosoftAuth {
  readonly clientId: string;
  /** The signed-in address, when sign-in saved it. */
  readonly email: string | undefined;
  /** A valid access token, refreshed shortly before it expires. */
  token(): Promise<string>;
  /** Refresh now, e.g. after a 401. */
  refresh(): Promise<string>;
}

/** The sign-in is gone for good: expired, revoked or missing. Retrying won't help; the account has to sign in again. */
export class MicrosoftAuthError extends SignInError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MicrosoftAuthError";
  }
}

/** What to do when Microsoft says the app isn't allowed to sign in without a secret. */
export const PUBLIC_CLIENT_HINT =
  'In your app registration, open Authentication, set "Allow public client flows" to Yes and click Save.';

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

class RefreshingAuth implements MicrosoftAuth {
  #tokens: MicrosoftTokens;
  #refreshing: Promise<string> | undefined;
  readonly #persist: ((tokens: MicrosoftTokens) => void | Promise<void>) | undefined;

  constructor(tokens: MicrosoftTokens, persist?: (tokens: MicrosoftTokens) => void | Promise<void>) {
    if (!tokens.clientId || !(tokens.accessToken || tokens.refreshToken)) {
      throw new Error("Microsoft auth needs a clientId and an access or refresh token.");
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
    const { clientId, clientSecret, tenant, refreshToken, scopes } = this.#tokens;
    if (!refreshToken) throw new MicrosoftAuthError("The Microsoft sign-in expired and there's no refresh token to renew it.");
    const response = await fetch(oauthUrl("token", tenant), {
      method: "POST",
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        ...(scopes?.length ? { scope: [...new Set([...scopes, "offline_access"])].join(" ") } : {}),
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      }),
    });
    const json = (await response.json().catch(() => ({}))) as TokenResponse;
    if (json.error === "invalid_grant" || json.error === "interaction_required") {
      throw new MicrosoftAuthError("Microsoft signed this account out: the sign-in expired, the password changed or access was revoked.");
    }
    if (json.error === "invalid_client") {
      const hint = clientSecret ? "Check its client secret, which may have expired." : PUBLIC_CLIENT_HINT;
      throw new Error(`Microsoft didn't accept the app ${clientId} (invalid_client). ${hint}`);
    }
    if (!response.ok || !json.access_token) {
      const why = typeof json.error === "string" ? ` ${json.error}` : "";
      throw new Error(`Couldn't refresh the Microsoft token (${response.status}${why}).`);
    }
    this.#tokens = {
      ...this.#tokens,
      accessToken: json.access_token,
      // Microsoft sends a new refresh token each time. Keep it: the old one stops working in 90 days.
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
export function withTokens(tokens: MicrosoftTokens, onRefresh?: (tokens: MicrosoftTokens) => void | Promise<void>): MicrosoftAuth {
  return new RefreshingAuth(tokens, onRefresh);
}

/**
 * One account of your own from the environment: `MICROSOFT_CLIENT_ID` and `MICROSOFT_REFRESH_TOKEN`,
 * plus `MICROSOFT_TENANT` for an app that only allows your organization and `MICROSOFT_CLIENT_SECRET`
 * for a web app's client. Microsoft replaces the refresh token as it's used, and one that's never
 * replaced stops working after 90 days, so this suits CI and short-lived servers best. Pass it
 * where a monitor starts, such as `start({ connections: [microsoft.fromEnv()] })`.
 */
export function fromEnv(env: NodeJS.ProcessEnv = process.env): Connection {
  const clientId = env.MICROSOFT_CLIENT_ID;
  if (!clientId || !(env.MICROSOFT_REFRESH_TOKEN || env.MICROSOFT_ACCESS_TOKEN)) {
    throw new Error("Set MICROSOFT_CLIENT_ID and MICROSOFT_REFRESH_TOKEN.");
  }
  return toConnection("microsoft", {
    account: "env",
    label: "MICROSOFT_REFRESH_TOKEN",
    credentials: {
      clientId,
      ...(env.MICROSOFT_CLIENT_SECRET ? { clientSecret: env.MICROSOFT_CLIENT_SECRET } : {}),
      ...(env.MICROSOFT_TENANT ? { tenant: env.MICROSOFT_TENANT } : {}),
      ...(env.MICROSOFT_REFRESH_TOKEN ? { refreshToken: env.MICROSOFT_REFRESH_TOKEN } : {}),
      ...(env.MICROSOFT_ACCESS_TOKEN ? { accessToken: env.MICROSOFT_ACCESS_TOKEN } : {}),
    },
  });
}
