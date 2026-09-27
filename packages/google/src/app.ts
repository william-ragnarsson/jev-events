import type { App, OAuthFlow } from "jev-events";

import { SCOPES } from "./auth.js";
import { exchangeCode, signInUrl, toNewConnection } from "./oauth.js";

export interface GoogleAppOptions {
  /** Your OAuth client's ID. Default: GOOGLE_CLIENT_ID. */
  clientId?: string;
  /** Default: GOOGLE_CLIENT_SECRET. */
  clientSecret?: string;
  /**
   * What each account is asked for: "gmail", "calendar", or full scope URLs. Default: Gmail and
   * Calendar. The address ("openid email") is always asked for, so each connection knows whose it is.
   */
  scopes?: readonly string[];
}

/** Your Google OAuth client. Register it with `runtime({ apps: [google.app()] })`. */
export interface GoogleApp extends App {
  readonly integration: "google";
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  /** The scopes every sign-in asks for. */
  readonly scopes: readonly string[];
  readonly oauth: OAuthFlow;
}

const NO_CLIENT =
  'Google needs your OAuth client: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or pass google.app({ clientId, clientSecret }). Create one of type "Web application" at https://console.cloud.google.com/auth/clients/create';

/**
 * Your OAuth client, so users can connect their Google accounts through `/connect/google` and
 * sources can renew tokens. The client ID and secret default to GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET, read when first needed.
 */
export function app(options: GoogleAppOptions = {}): GoogleApp {
  const scopes = expandScopes(["openid", "email", ...(options.scopes ?? ["gmail", "calendar"])]);
  const clientId = () => options.clientId ?? (process.env.GOOGLE_CLIENT_ID || undefined);
  const clientSecret = () => options.clientSecret ?? (process.env.GOOGLE_CLIENT_SECRET || undefined);
  const requireClientId = () => {
    const id = clientId();
    if (!id) throw new Error(NO_CLIENT);
    return id;
  };
  return {
    integration: "google",
    get clientId() {
      return clientId();
    },
    get clientSecret() {
      return clientSecret();
    },
    scopes,
    oauth: {
      authorizeUrl: ({ redirectUri, state, codeChallenge, scopes: extra }) =>
        signInUrl({ clientId: requireClientId(), redirectUri, state, codeChallenge, scopes: expandScopes([...scopes, ...(extra ?? [])]) }),
      complete: async ({ code, redirectUri, codeVerifier }) =>
        toNewConnection(
          await exchangeCode({
            clientId: requireClientId(),
            clientSecret: clientSecret(),
            code,
            codeVerifier,
            redirectUri,
            scopes,
            invalidClientHint: "Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
          }),
        ),
    },
  };
}

/** Short names to scope URLs, without repeats. */
export function expandScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => (SCOPES as Record<string, string>)[scope] ?? scope))];
}
