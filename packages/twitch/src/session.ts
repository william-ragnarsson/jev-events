import type { Connection, Credentials, SessionContext } from "jev-events";

import type { TwitchApp } from "./app.js";
import { TwitchAuthError, withTokens, type TwitchAuth, type TwitchTokens } from "./auth.js";
import { Helix } from "./helix.js";

/** What the chat source and the Twitch actions use for one connected account. */
export interface TwitchSession {
  helix: Helix;
  /** The signed-in account. Chat is read, and actions run, as this account. */
  userId: string;
  login: string;
  /** What the account allowed at sign-in, such as "moderator:manage:banned_users". */
  scopes: string[];
  /** The channel being read, lowercase. */
  channel: string;
  /** The channel's user id. */
  broadcasterId: string;
}

const NO_CLIENT =
  "Twitch needs your app's Client ID to use this account's token: set TWITCH_CLIENT_ID, or pass runtime({ apps: [twitch.app({ clientId })] }). It's under Manage at https://dev.twitch.tv/console/apps";

const env = (name: string) => process.env[name] || undefined;

/**
 * Auth for the connection, which saves renewed tokens back to it. Tokens belong to the app that
 * made them, so the client ID comes from the connection (sign-in saves it there), else the
 * registered app, else TWITCH_CLIENT_ID.
 */
export function connectedAuth(ctx: SessionContext, connection: Connection): TwitchAuth {
  const credentials = connection.credentials as Credentials & Partial<TwitchTokens>;
  if (!credentials.accessToken && !credentials.refreshToken) {
    throw new TwitchAuthError(`The Twitch connection ${connection.label ?? connection.id} has no tokens. Sign in again.`);
  }
  const app = ctx.app as Partial<TwitchApp> | undefined;
  const clientId = credentials.clientId || app?.clientId || env("TWITCH_CLIENT_ID");
  if (!clientId) throw new Error(NO_CLIENT);
  const clientSecret =
    credentials.clientSecret ||
    (app?.clientId === clientId ? app.clientSecret : undefined) ||
    (env("TWITCH_CLIENT_ID") === clientId ? env("TWITCH_CLIENT_SECRET") : undefined);

  return withTokens(
    {
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      ...(credentials.accessToken ? { accessToken: credentials.accessToken } : {}),
      ...(credentials.refreshToken ? { refreshToken: credentials.refreshToken } : {}),
      ...(credentials.expiresAt ? { expiresAt: credentials.expiresAt } : {}),
    },
    async (tokens) => {
      try {
        await ctx.saveCredentials({
          ...connection.credentials,
          ...(tokens.accessToken ? { accessToken: tokens.accessToken } : {}),
          ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
          ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
        });
      } catch (error) {
        // The renewed token works for this session. A Public app's refresh token works once, though,
        // so the next session may have to sign in again.
        ctx.log.warn("Couldn't save the renewed Twitch token:", error);
      }
    },
  );
}

/**
 * Check the account's token (Twitch wants that at start), and find the channel to read: the one
 * named, else the account's own.
 */
export async function openSession(ctx: SessionContext, source: string, channel: string | undefined): Promise<TwitchSession> {
  if (!ctx.connection) {
    throw new Error(
      `${source} reads chat as a signed-in Twitch account, so it needs a connection. Sign in with npx jev-events auth twitch, or pass connections to start(). To read a channel without signing in, use twitchChat("<channel>") from jev-events/public.`,
    );
  }
  const auth = connectedAuth(ctx, ctx.connection);
  const helix = new Helix(auth);
  const { userId, login, scopes } = await auth.identity();
  if (!scopes.includes("user:read:chat")) {
    throw new TwitchAuthError(`The Twitch account ${login} hasn't allowed reading chat (the user:read:chat scope). Sign in again and allow it.`);
  }
  const account = { helix, userId, login, scopes };
  if (!channel || channel === login) return { ...account, channel: login, broadcasterId: userId };
  const broadcaster = await helix.userByLogin(channel);
  if (!broadcaster) throw new Error(`There's no Twitch channel called ${channel}.`);
  return { ...account, channel: broadcaster.login, broadcasterId: broadcaster.id };
}
