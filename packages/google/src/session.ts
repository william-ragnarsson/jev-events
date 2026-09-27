import type { Connection, Credentials, SessionContext } from "jev-events";

import { GoogleApi } from "./api.js";
import type { GoogleApp } from "./app.js";
import { GoogleAuthError, withTokens, type GoogleTokens } from "./auth.js";

const NO_CLIENT =
  "Google needs your OAuth client to renew this account's token: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or pass runtime({ apps: [google.app({ clientId, clientSecret })] }).";

/** The connection a Google source reads. There always is one; this is for sources used without a runtime. */
export function connectionOf(ctx: SessionContext, source: string): Connection {
  if (!ctx.connection) {
    throw new Error(`${source} reads signed-in Google accounts, so it needs a connection. Sign in with npx jev-events auth google, or pass connections to start().`);
  }
  return ctx.connection;
}

/**
 * An API client for the connection, which saves renewed tokens back to it. The OAuth client comes
 * from the registered app, else the connection (the CLI saves it there), else the environment.
 */
export function connectedApi(ctx: SessionContext, connection: Connection, options: { retryBaseMs?: number } = {}): GoogleApi {
  const credentials = connection.credentials as Credentials & Partial<GoogleTokens>;
  if (!credentials.accessToken && !credentials.refreshToken) {
    throw new GoogleAuthError(`The Google connection ${connection.label ?? connection.id} has no tokens. Sign in again.`);
  }
  const app = ctx.app as Partial<GoogleApp> | undefined;
  const client = app?.clientId
    ? { clientId: app.clientId, clientSecret: app.clientSecret }
    : credentials.clientId
      ? { clientId: credentials.clientId, clientSecret: credentials.clientSecret }
      : { clientId: process.env.GOOGLE_CLIENT_ID || undefined, clientSecret: process.env.GOOGLE_CLIENT_SECRET || undefined };
  if (!client.clientId) throw new Error(NO_CLIENT);

  const auth = withTokens(
    {
      clientId: client.clientId,
      ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
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
        // The renewed token works for this session anyway; the next one renews it again.
        ctx.log.warn("Couldn't save the renewed Google token:", error);
      }
    },
  );
  return new GoogleApi(auth, options);
}

/** The signed-in address: saved at sign-in, else asked of `lookup`. */
export async function addressOf(connection: Connection, lookup: () => Promise<string>): Promise<string> {
  const saved = connection.facts?.email;
  if (typeof saved === "string" && saved) return saved.toLowerCase();
  if (connection.label?.includes("@")) return connection.label.toLowerCase();
  return (await lookup()).toLowerCase();
}
