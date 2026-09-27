import type { NewConnection } from "jev-events";

import { endpoints } from "./endpoints.js";

/** What Google hands back after a sign-in. */
export interface SignedIn {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  /** What the account allowed, which can be less than what was asked for. */
  scopes: string[];
  /** The account's address, when "email" was asked for. */
  email?: string;
}

export interface SignInUrlOptions {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  codeChallenge: string;
  state: string;
}

/** Google's consent page. Asks for a refresh token, and for consent every time so Google always sends one. */
export function signInUrl(options: SignInUrlOptions): string {
  const url = new URL(endpoints().authorize);
  url.search = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: options.scopes.join(" "),
    code_challenge: options.codeChallenge,
    code_challenge_method: "S256",
    state: options.state,
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return url.href;
}

export interface ExchangeOptions {
  clientId: string;
  clientSecret?: string | undefined;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  /** Assumed granted when Google doesn't list the scopes. */
  scopes: readonly string[];
  /** Added to the error when Google doesn't know the client or its secret. */
  invalidClientHint: string;
}

/** Trade the code from Google's redirect for tokens. */
export async function exchangeCode(options: ExchangeOptions): Promise<SignedIn> {
  const response = await fetch(endpoints().token, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      code_verifier: options.codeVerifier,
      redirect_uri: options.redirectUri,
      client_id: options.clientId,
      ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
    }),
  });
  const json = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !json.access_token) {
    const why = json.error_description ?? json.error ?? String(response.status);
    const hint = json.error === "invalid_client" ? ` ${options.invalidClientHint}` : "";
    throw new Error(`Google refused the sign-in: ${why}.${hint}`);
  }
  const email = emailFromIdToken(json.id_token);
  return {
    accessToken: json.access_token,
    ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    ...(json.expires_in ? { expiresAt: Date.now() + json.expires_in * 1000 } : {}),
    scopes: json.scope ? json.scope.split(" ") : [...options.scopes],
    ...(email ? { email } : {}),
  };
}

function emailFromIdToken(idToken: string | undefined): string | undefined {
  const payload = idToken?.split(".")[1];
  if (!payload) return undefined;
  try {
    return (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string }).email;
  } catch {
    return undefined;
  }
}

/**
 * The connection to save for a sign-in, named after the account's address. Pass the OAuth client
 * when no app will be registered to renew the tokens, as with the CLI.
 */
export function toNewConnection(signedIn: SignedIn, client?: { clientId: string; clientSecret?: string }): NewConnection {
  const { email, ...tokens } = signedIn;
  return {
    account: email ?? "google",
    ...(email ? { label: email } : {}),
    credentials: {
      ...(client ? { clientId: client.clientId, ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}) } : {}),
      ...tokens,
    },
    ...(email ? { facts: { email } } : {}),
  };
}
