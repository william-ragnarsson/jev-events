import type { App, NewConnection, OAuthFlow } from "jev-events";

import { DEFAULT_SCOPES, withTokens } from "./auth.js";
import { endpoints } from "./endpoints.js";

export interface TwitchAppOptions {
  /** Your Twitch app's Client ID, under Manage at https://dev.twitch.tv/console/apps. Default: TWITCH_CLIENT_ID. */
  clientId?: string;
  /**
   * The app's client secret, which signing people in through `/connect/twitch` needs, so the app's
   * client type has to be Confidential. Default: TWITCH_CLIENT_SECRET.
   */
  clientSecret?: string;
  /** What each account is asked for. Default: reading and sending chat, and the moderation the actions do. */
  scopes?: readonly string[];
}

/** Your Twitch app. Register it with `runtime({ apps: [twitch.app()] })`. */
export interface TwitchApp extends App {
  readonly integration: "twitch";
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  readonly scopes: readonly string[];
  readonly oauth: OAuthFlow;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  message?: string;
}

const NO_CLIENT =
  "Twitch needs your app's credentials: set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET, or pass twitch.app({ clientId, clientSecret }). They're under Manage at https://dev.twitch.tv/console/apps, where the app's client type has to be Confidential to have a secret.";

/**
 * Your Twitch app, so people can connect their Twitch accounts through `/connect/twitch`. Add
 * `<your baseUrl>/callback/twitch` under OAuth Redirect URLs in the app. Each setting defaults to
 * its environment variable, read when first needed.
 */
export function app(options: TwitchAppOptions = {}): TwitchApp {
  const scopes = [...new Set(options.scopes ?? DEFAULT_SCOPES)];
  const env = (name: string) => process.env[name] || undefined;
  const clientId = () => options.clientId ?? env("TWITCH_CLIENT_ID");
  const clientSecret = () => options.clientSecret ?? env("TWITCH_CLIENT_SECRET");
  const client = () => {
    const id = clientId();
    const secret = clientSecret();
    if (!id || !secret) throw new Error(NO_CLIENT);
    return { id, secret };
  };
  return {
    integration: "twitch",
    get clientId() {
      return clientId();
    },
    get clientSecret() {
      return clientSecret();
    },
    scopes,
    oauth: {
      // Twitch doesn't take PKCE: the client secret proves it's your app when the code is traded.
      authorizeUrl: ({ redirectUri, state, scopes: extra }) => {
        const url = new URL(`${endpoints().id}/authorize`);
        url.search = new URLSearchParams({
          client_id: client().id,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: [...new Set([...scopes, ...(extra ?? [])])].join(" "),
          state,
        }).toString();
        return url.href;
      },
      complete: async ({ code, redirectUri }) => {
        const { id, secret } = client();
        return signedIn(id, secret, await exchange({ id, secret, code, redirectUri }));
      },
    },
  };
}

/** Trade the code from Twitch's redirect for the account's tokens. */
async function exchange(options: { id: string; secret: string; code: string; redirectUri: string }): Promise<TokenResponse & { access_token: string }> {
  const response = await fetch(`${endpoints().id}/token`, {
    method: "POST",
    body: new URLSearchParams({
      client_id: options.id,
      client_secret: options.secret,
      code: options.code,
      grant_type: "authorization_code",
      redirect_uri: options.redirectUri,
    }),
  });
  const json = (await response.json().catch(() => ({}))) as TokenResponse;
  if (response.ok && json.access_token) return { ...json, access_token: json.access_token };
  const message = json.message ?? "";
  if (/redirect/i.test(message)) {
    throw new Error(`Twitch refused the sign-in: add ${options.redirectUri} under OAuth Redirect URLs in your app at https://dev.twitch.tv/console/apps.`);
  }
  if (/client secret/i.test(message)) throw new Error("Twitch refused the sign-in: the client secret is wrong. Check TWITCH_CLIENT_SECRET.");
  if (/client/i.test(message)) throw new Error("Twitch refused the sign-in: the client ID is wrong. Check TWITCH_CLIENT_ID.");
  if (/code/i.test(message)) throw new Error("Twitch refused the sign-in: the code expired or was already used. Try connecting again.");
  throw new Error(`Twitch refused the sign-in (${message || response.status}).`);
}

/** The connection to save: the account, and its tokens. The client secret stays with the app. */
async function signedIn(clientId: string, clientSecret: string, tokens: TokenResponse & { access_token: string }): Promise<NewConnection> {
  const credentials = {
    clientId,
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    ...(tokens.expires_in ? { expiresAt: Date.now() + tokens.expires_in * 1000 } : {}),
  };
  const { userId, login, scopes } = await withTokens({ ...credentials, clientSecret }).identity();
  return { account: userId, label: login, credentials, facts: { userId, login, scopes } };
}
