import { DEFAULT_CREDENTIALS_PATH, readCredentials, writeCredentials } from "jev-events";

const ID = "https://id.twitch.tv/oauth2";

/**
 * The scopes `jev-events auth twitch` asks for: read and send chat, and moderate. The bot
 * account also needs to be a moderator in the channel (`/mod <bot>`).
 */
export const DEFAULT_SCOPES = [
  "user:read:chat",
  "user:write:chat",
  "moderator:manage:banned_users",
  "moderator:manage:chat_messages",
  "moderator:manage:warnings",
  "clips:edit",
];

/**
 * Client ID of the public "Jev Events" Twitch app used by `jev-events auth twitch`.
 * Empty until that app is registered; pass `--client-id` or set TWITCH_CLIENT_ID meanwhile.
 */
export const JEV_EVENTS_CLIENT_ID = "";

export interface TwitchTokens {
  clientId: string;
  /** Only for confidential apps. Public (device-flow) apps refresh without one. */
  clientSecret?: string;
  accessToken: string;
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
  /** A valid access token, refreshed shortly before it expires. */
  token(): Promise<string>;
  /** Refresh now, e.g. after a 401. */
  refresh(): Promise<string>;
  /** Who the token belongs to, and its scopes. */
  identity(): Promise<TwitchIdentity>;
}

class RefreshingAuth implements TwitchAuth {
  #tokens: TwitchTokens;
  #identity: Promise<TwitchIdentity> | undefined;
  #refreshing: Promise<string> | undefined;
  readonly #persist: ((tokens: TwitchTokens) => void) | undefined;

  constructor(tokens: TwitchTokens, persist?: (tokens: TwitchTokens) => void) {
    if (!tokens.clientId || !tokens.accessToken) throw new Error("Twitch auth needs a clientId and an accessToken.");
    this.#tokens = { ...tokens };
    this.#persist = persist;
  }

  get clientId(): string {
    return this.#tokens.clientId;
  }

  async token(): Promise<string> {
    const { expiresAt, refreshToken } = this.#tokens;
    if (expiresAt !== undefined && refreshToken && expiresAt - Date.now() < 60_000) return this.refresh();
    return this.#tokens.accessToken;
  }

  refresh(): Promise<string> {
    this.#refreshing ??= this.#doRefresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #doRefresh(): Promise<string> {
    const { clientId, clientSecret, refreshToken } = this.#tokens;
    if (!refreshToken) {
      throw new Error("The Twitch token expired and there's no refresh token. Sign in again: npx jev-events auth twitch");
    }
    const response = await fetch(`${ID}/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`Couldn't refresh the Twitch token (${response.status}). Sign in again: npx jev-events auth twitch`);
    }
    const json = (await response.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    this.#tokens = {
      ...this.#tokens,
      accessToken: json.access_token,
      ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
      ...(json.expires_in ? { expiresAt: Date.now() + json.expires_in * 1000 } : {}),
    };
    this.#identity = undefined;
    this.#persist?.(this.#tokens);
    return this.#tokens.accessToken;
  }

  identity(): Promise<TwitchIdentity> {
    this.#identity ??= this.#validate().catch((error: unknown) => {
      this.#identity = undefined;
      throw error;
    });
    return this.#identity;
  }

  async #validate(retried = false): Promise<TwitchIdentity> {
    const response = await fetch(`${ID}/validate`, { headers: { Authorization: `OAuth ${await this.token()}` } });
    if (response.status === 401 && !retried && this.#tokens.refreshToken) {
      await this.refresh();
      return this.#validate(true);
    }
    if (!response.ok) throw new Error(`The Twitch token is invalid (${response.status}). Sign in again: npx jev-events auth twitch`);
    const json = (await response.json()) as { user_id?: string; login?: string; scopes?: string[] };
    if (!json.user_id || !json.login) throw new Error("This is an app token; Jev Events needs a user token for a chat bot account.");
    return { userId: json.user_id, login: json.login, scopes: json.scopes ?? [] };
  }
}

/** Use tokens you manage yourself. `onRefresh` receives rotated tokens so you can store them. */
export function withTokens(tokens: TwitchTokens, onRefresh?: (tokens: TwitchTokens) => void): TwitchAuth {
  return new RefreshingAuth(tokens, onRefresh);
}

/** Tokens saved by `npx jev-events auth twitch`. Refreshed tokens are written back. */
export function fromFile(path = DEFAULT_CREDENTIALS_PATH): TwitchAuth {
  const tokens = readCredentials<TwitchTokens>("twitch", path);
  if (!tokens) throw new Error(`No Twitch credentials in ${path}. Sign in first: npx jev-events auth twitch`);
  return new RefreshingAuth(tokens, (next) => writeCredentials("twitch", { ...readCredentials<Record<string, unknown>>("twitch", path), ...next }, path));
}

/** TWITCH_CLIENT_ID, TWITCH_ACCESS_TOKEN, and optionally TWITCH_REFRESH_TOKEN and TWITCH_CLIENT_SECRET. */
export function fromEnv(env: NodeJS.ProcessEnv = process.env): TwitchAuth {
  const clientId = env.TWITCH_CLIENT_ID;
  const accessToken = env.TWITCH_ACCESS_TOKEN;
  if (!clientId || !accessToken) throw new Error("Set TWITCH_CLIENT_ID and TWITCH_ACCESS_TOKEN.");
  return new RefreshingAuth({
    clientId,
    accessToken,
    ...(env.TWITCH_REFRESH_TOKEN ? { refreshToken: env.TWITCH_REFRESH_TOKEN } : {}),
    ...(env.TWITCH_CLIENT_SECRET ? { clientSecret: env.TWITCH_CLIENT_SECRET } : {}),
  });
}

export interface AuthorizeOptions {
  "client-id"?: string;
  /** Space- or comma-separated scopes. Defaults to DEFAULT_SCOPES. */
  scopes?: string;
  path?: string;
  /** Where to print instructions. Default stdout. */
  print?: (line: string) => void;
}

/**
 * Sign a bot account in with Twitch's device code flow and save the tokens.
 * This is what `npx jev-events auth twitch` runs.
 */
export async function authorize(options: AuthorizeOptions = {}): Promise<TwitchIdentity> {
  const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const clientId = options["client-id"] ?? process.env.TWITCH_CLIENT_ID ?? JEV_EVENTS_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      "Pass --client-id <id>. Register an app with client type \"Public\" at https://dev.twitch.tv/console/apps.",
    );
  }
  const scopes = options.scopes ? options.scopes.split(/[\s,]+/).filter(Boolean) : DEFAULT_SCOPES;

  const deviceResponse = await fetch(`${ID}/device`, {
    method: "POST",
    body: new URLSearchParams({ client_id: clientId, scopes: scopes.join(" ") }),
  });
  if (!deviceResponse.ok) {
    throw new Error(`Twitch refused the sign-in (${deviceResponse.status}): ${await deviceResponse.text()}. Is the app's client type "Public"?`);
  }
  const device = (await deviceResponse.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };

  print("");
  print(`  Open ${device.verification_uri}`);
  print(`  and enter the code ${device.user_code} while signed in as your bot account.`);
  print(`  Waiting… (expires in ${Math.round(device.expires_in / 60)} minutes)`);

  let interval = device.interval * 1000;
  const deadline = Date.now() + device.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const response = await fetch(`${ID}/token`, {
      method: "POST",
      body: new URLSearchParams({
        client_id: clientId,
        scopes: scopes.join(" "),
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const json = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      message?: string;
    };
    if (response.ok && json.access_token) {
      const tokens: TwitchTokens = {
        clientId,
        accessToken: json.access_token,
        ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
        ...(json.expires_in ? { expiresAt: Date.now() + json.expires_in * 1000 } : {}),
      };
      const identity = await withTokens(tokens).identity();
      const path = options.path ?? DEFAULT_CREDENTIALS_PATH;
      writeCredentials("twitch", { ...tokens, login: identity.login, userId: identity.userId, scopes: identity.scopes }, path);
      print("");
      print(`  Signed in as ${identity.login}. Saved to ${path}.`);
      print(`  Make the bot a moderator in your channel: /mod ${identity.login}`);
      return identity;
    }
    if (json.message === "authorization_pending") continue;
    if (json.message === "slow_down") {
      interval += 5_000;
      continue;
    }
    throw new Error(`Sign-in failed: ${json.message ?? response.status}.`);
  }
  throw new Error("The code expired before it was entered. Run the command again.");
}
