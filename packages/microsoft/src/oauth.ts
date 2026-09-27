import type { NewConnection } from "jev-events";

import { endpoints, oauthUrl } from "./endpoints.js";

/** Personal accounts (outlook.com, hotmail.com, live.com) all sign in through this directory. */
export const PERSONAL_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

/** What Microsoft hands back after a sign-in. */
export interface SignedIn {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  /** What the account allowed, asked for again when the token is renewed. */
  scopes: string[];
  /** A personal Microsoft account rather than a work or school one. Teams needs the latter. */
  personal?: boolean;
}

/** The signed-in person, from Graph's `/me`. */
export interface MicrosoftUser {
  /** The account's id in its directory, which never changes. */
  id: string;
  /** Their address, when the account has one. */
  email: string | undefined;
  name: string | undefined;
}

/** A token response from Microsoft's sign-in. */
export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

export interface SignInUrlOptions {
  clientId: string;
  /** Default "common". */
  tenant?: string | undefined;
  redirectUri: string;
  scopes: readonly string[];
  codeChallenge: string;
  state: string;
}

/** Microsoft's sign-in page. It always asks which account, so switching accounts is easy. */
export function signInUrl(options: SignInUrlOptions): string {
  const url = new URL(oauthUrl("authorize", options.tenant));
  url.search = new URLSearchParams({
    client_id: options.clientId,
    response_type: "code",
    redirect_uri: options.redirectUri,
    response_mode: "query",
    scope: options.scopes.join(" "),
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.href;
}

export interface ExchangeOptions {
  clientId: string;
  clientSecret?: string | undefined;
  tenant?: string | undefined;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  scopes: readonly string[];
  /** Added to the error when Microsoft doesn't know the client or its secret. */
  invalidClientHint: string;
}

/** Trade the code from Microsoft's redirect for tokens. */
export async function exchangeCode(options: ExchangeOptions): Promise<SignedIn> {
  const response = await fetch(oauthUrl("token", options.tenant), {
    method: "POST",
    body: new URLSearchParams({
      client_id: options.clientId,
      grant_type: "authorization_code",
      code: options.code,
      code_verifier: options.codeVerifier,
      redirect_uri: options.redirectUri,
      scope: options.scopes.join(" "),
      ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
    }),
  });
  const json = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !json.access_token) {
    const hint = json.error === "invalid_client" ? ` ${options.invalidClientHint}` : "";
    throw new Error(`Microsoft refused the sign-in: ${describeError(json, response.status)}.${hint}`);
  }
  return signedInFrom({ ...json, access_token: json.access_token }, options.scopes);
}

/** The tokens from a successful token response. */
export function signedInFrom(json: TokenResponse & { access_token: string }, requested: readonly string[]): SignedIn {
  return {
    accessToken: json.access_token,
    ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    ...(json.expires_in ? { expiresAt: Date.now() + json.expires_in * 1000 } : {}),
    scopes: json.scope ? json.scope.split(" ").filter(Boolean) : [...requested],
    ...(claimsOf(json.id_token).tid === PERSONAL_TENANT ? { personal: true } : {}),
  };
}

function claimsOf(idToken: string | undefined): { tid?: string } {
  const payload = idToken?.split(".")[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { tid?: string };
  } catch {
    return {};
  }
}

/** The first line of Microsoft's error, without the trace and correlation ids after it. */
export function describeError(json: { error?: string; error_description?: string }, status: number): string {
  const first = json.error_description?.split(/\r?\n/)[0]?.replace(/\s*Trace ID:.*$/s, "").trim();
  return (first || json.error || `HTTP ${status}`).replace(/\.$/, "");
}

/** What Graph's `/me` returns, as far as Jev reads it. */
export interface GraphUser {
  id?: string;
  displayName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
}

/** The fields `/me` is asked for. */
export const USER_FIELDS = "id,displayName,mail,userPrincipalName";

/** The address is `mail`, else the sign-in name when it's a real address rather than a guest's `…#EXT#@…` one. */
export function toUser(user: GraphUser): MicrosoftUser {
  const principal = user.userPrincipalName;
  const email = user.mail || (principal && principal.includes("@") && !principal.includes("#EXT#") ? principal : undefined);
  return { id: user.id ?? "", email: email?.toLowerCase(), name: user.displayName || undefined };
}

/** Who signed in: their id, address and name. */
export async function whoSignedIn(accessToken: string): Promise<MicrosoftUser> {
  const url = new URL(`${endpoints().graph}/me`);
  url.searchParams.set("$select", USER_FIELDS);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = (await response.json().catch(() => ({}))) as GraphUser;
  if (!response.ok || !json.id) throw new Error(`Couldn't read the signed-in Microsoft account (${response.status}).`);
  return toUser(json);
}

/**
 * The connection to save for a sign-in, named after the account's address. Pass the client when no
 * app will be registered to renew the tokens, as with the CLI.
 */
export function toNewConnection(
  signedIn: SignedIn,
  user: MicrosoftUser,
  client?: { clientId: string; clientSecret?: string | undefined; tenant?: string | undefined },
): NewConnection {
  return {
    account: user.id,
    label: user.email ?? user.name ?? user.id,
    credentials: {
      ...(client
        ? {
            clientId: client.clientId,
            ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
            ...(client.tenant && client.tenant !== "common" ? { tenant: client.tenant } : {}),
          }
        : {}),
      accessToken: signedIn.accessToken,
      ...(signedIn.refreshToken ? { refreshToken: signedIn.refreshToken } : {}),
      ...(signedIn.expiresAt ? { expiresAt: signedIn.expiresAt } : {}),
      scopes: signedIn.scopes,
    },
    facts: {
      userId: user.id,
      ...(user.email ? { email: user.email } : {}),
      ...(user.name ? { name: user.name } : {}),
      ...(signedIn.personal ? { personal: true } : {}),
    },
  };
}
