import type { App, OAuthFlow } from "jev-events";

import { expandScopes, SIGN_IN_SCOPES } from "./auth.js";
import { exchangeCode, signInUrl, toNewConnection, whoSignedIn } from "./oauth.js";

export interface MicrosoftAppOptions {
  /** Your app registration's Application (client) ID. Default: MICROSOFT_CLIENT_ID. */
  clientId?: string;
  /** A client secret from Certificates & secrets. Default: MICROSOFT_CLIENT_SECRET. */
  clientSecret?: string;
  /**
   * Who may sign in: "common" for any work, school or personal account, "organizations" for work and
   * school accounts, or your directory's id for your organization only. Default: MICROSOFT_TENANT,
   * else "common".
   */
  tenant?: string;
  /**
   * What each account is asked for: "outlook", "calendar", "teams", or Graph permission names such as
   * "Mail.Read". Default: all three. Who signed in ("openid profile email User.Read") and a refresh
   * token ("offline_access") are always asked for.
   */
  scopes?: readonly string[];
}

/** Your Microsoft app registration. Register it with `runtime({ apps: [microsoft.app()] })`. */
export interface MicrosoftApp extends App {
  readonly integration: "microsoft";
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  readonly tenant: string;
  /** The permissions every sign-in asks for. */
  readonly scopes: readonly string[];
  readonly oauth: OAuthFlow;
}

const NO_CLIENT =
  "Microsoft needs your app registration: set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET, or pass microsoft.app({ clientId, clientSecret }). Register one at https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade";

/**
 * Your app registration, so users can connect their Microsoft accounts through `/connect/microsoft`
 * and sources can renew tokens. The client ID, secret and tenant default to MICROSOFT_CLIENT_ID,
 * MICROSOFT_CLIENT_SECRET and MICROSOFT_TENANT, read when first needed.
 */
export function app(options: MicrosoftAppOptions = {}): MicrosoftApp {
  const scopes = expandScopes([...SIGN_IN_SCOPES, ...(options.scopes ?? ["outlook", "calendar", "teams"])]);
  const clientId = () => options.clientId ?? (process.env.MICROSOFT_CLIENT_ID || undefined);
  const clientSecret = () => options.clientSecret ?? (process.env.MICROSOFT_CLIENT_SECRET || undefined);
  const tenant = () => options.tenant ?? (process.env.MICROSOFT_TENANT || "common");
  const requireClientId = () => {
    const id = clientId();
    if (!id) throw new Error(NO_CLIENT);
    return id;
  };
  return {
    integration: "microsoft",
    get clientId() {
      return clientId();
    },
    get clientSecret() {
      return clientSecret();
    },
    get tenant() {
      return tenant();
    },
    scopes,
    oauth: {
      authorizeUrl: ({ redirectUri, state, codeChallenge, scopes: extra }) =>
        signInUrl({
          clientId: requireClientId(),
          tenant: tenant(),
          redirectUri,
          state,
          codeChallenge,
          scopes: expandScopes([...scopes, ...(extra ?? [])]),
        }),
      complete: async ({ code, redirectUri, codeVerifier }) => {
        const signedIn = await exchangeCode({
          clientId: requireClientId(),
          clientSecret: clientSecret(),
          tenant: tenant(),
          code,
          codeVerifier,
          redirectUri,
          scopes,
          invalidClientHint: "Check MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET, and that the secret hasn't expired.",
        });
        return toNewConnection(signedIn, await whoSignedIn(signedIn.accessToken));
      },
    },
  };
}
