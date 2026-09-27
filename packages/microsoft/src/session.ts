import type { Connection, Credentials, SessionContext } from "jev-events";

import { GraphApi } from "./api.js";
import type { MicrosoftApp } from "./app.js";
import { MicrosoftAuthError, withTokens, type MicrosoftTokens } from "./auth.js";
import { toUser, USER_FIELDS, type GraphUser, type MicrosoftUser } from "./oauth.js";

const NO_CLIENT =
  "Microsoft needs your app registration to renew this account's token: set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET, or pass runtime({ apps: [microsoft.app({ clientId, clientSecret })] }).";

/** The connection a Microsoft source reads. There always is one; this is for sources used without a runtime. */
export function connectionOf(ctx: SessionContext, source: string): Connection {
  if (!ctx.connection) {
    throw new Error(
      `${source} reads signed-in Microsoft accounts, so it needs a connection. Sign in with npx jev-events auth microsoft, or pass connections to start().`,
    );
  }
  return ctx.connection;
}

/**
 * A Graph client for a connection. Tokens from the CLI or the environment carry the app they were
 * issued to; tokens from your web app's sign-in use the app registered with the runtime.
 */
export function connectedApi(ctx: SessionContext, connection: Connection, options: { retryBaseMs?: number } = {}): GraphApi {
  const credentials = connection.credentials as Credentials & Partial<MicrosoftTokens>;
  if (!credentials.accessToken && !credentials.refreshToken) {
    throw new MicrosoftAuthError(`The Microsoft connection ${connection.label ?? connection.id} has no tokens. Sign in again.`);
  }
  const client = clientFor(credentials, ctx.app as Partial<MicrosoftApp> | undefined);
  const auth = withTokens(
    {
      ...client,
      ...(credentials.accessToken ? { accessToken: credentials.accessToken } : {}),
      ...(credentials.refreshToken ? { refreshToken: credentials.refreshToken } : {}),
      ...(credentials.expiresAt ? { expiresAt: credentials.expiresAt } : {}),
      ...(Array.isArray(credentials.scopes) ? { scopes: credentials.scopes } : {}),
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
        ctx.log.warn("Couldn't save the renewed Microsoft token:", error);
      }
    },
  );
  return new GraphApi(auth, options);
}

/**
 * Which app renews the tokens. A refresh token only works with the app that got it, and a secret
 * sent for tokens from a public client is refused, so saved clients are used as they are.
 */
function clientFor(credentials: Partial<MicrosoftTokens>, app: Partial<MicrosoftApp> | undefined): Pick<MicrosoftTokens, "clientId" | "clientSecret" | "tenant"> {
  if (credentials.clientId) {
    return {
      clientId: credentials.clientId,
      ...(credentials.clientSecret ? { clientSecret: credentials.clientSecret } : {}),
      ...(credentials.tenant ? { tenant: credentials.tenant } : {}),
    };
  }
  const env = process.env;
  const clientId = app?.clientId ?? (env.MICROSOFT_CLIENT_ID || undefined);
  if (!clientId) throw new Error(NO_CLIENT);
  const clientSecret = app?.clientId ? app.clientSecret : env.MICROSOFT_CLIENT_SECRET || undefined;
  const tenant = credentials.tenant ?? (app?.clientId ? app.tenant : env.MICROSOFT_TENANT || undefined);
  return { clientId, ...(clientSecret ? { clientSecret } : {}), ...(tenant ? { tenant } : {}) };
}

/** The signed-in account: saved at sign-in, else asked of Graph. */
export async function whoAmI(connection: Connection, api: GraphApi): Promise<MicrosoftUser> {
  const facts = connection.facts ?? {};
  if (typeof facts.userId === "string" && facts.userId) {
    return {
      id: facts.userId,
      email: typeof facts.email === "string" && facts.email ? facts.email.toLowerCase() : undefined,
      name: typeof facts.name === "string" && facts.name ? facts.name : undefined,
    };
  }
  return toUser(await api.call<GraphUser>("GET", "/me", { query: { $select: USER_FIELDS } }));
}
