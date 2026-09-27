import type { JsonValue } from "@typesafe-ai/sdk";

/** Tokens and secrets for one connection. Stored encrypted when the store has a key. */
export type Credentials = { [key: string]: JsonValue };

export type ConnectionStatus = "active" | "paused" | "needs-sign-in";

/**
 * One signed-in account of one integration, such as dana@acme.com's Google account. A monitor
 * whose source has an `integration` runs once for every active connection of that integration.
 */
export interface Connection {
  /** Stable id, such as "google:dana@acme.com". Signing in again updates the same connection. */
  id: string;
  /** The integration it belongs to, such as "google" or "slack". */
  integration: string;
  /** Your product's id for the user who connected it. */
  userId?: string;
  /** A readable name, such as the email address or workspace name. */
  label?: string;
  /** Tokens. Never shown to handlers or sent to Jev. */
  credentials: Credentials;
  /** Account facts learned at sign-in, such as the email address, time zone or workspace id. */
  facts?: { [key: string]: JsonValue };
  /** Default "active". Monitors skip paused connections and ones that need a new sign-in. */
  status?: ConnectionStatus;
  /** Why the connection needs attention, such as "Google revoked access". */
  problem?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** A connection without its tokens: what events, handlers and profiles see. */
export type ConnectionInfo = Readonly<Omit<Connection, "credentials">>;

/** What an integration's sign-in returns. The runtime turns it into a saved connection. */
export interface NewConnection {
  /** Identifies the account within the integration, such as an email address or workspace id. */
  account: string;
  label?: string;
  credentials: Credentials;
  facts?: { [key: string]: JsonValue };
}

/** An OAuth sign-in flow. Integrations provide one through their `app()`. */
export interface OAuthFlow {
  /** The provider's consent page for this sign-in. */
  authorizeUrl(options: { redirectUri: string; state: string; codeChallenge: string; scopes?: readonly string[] }): string;
  /** Exchange the code from the callback for tokens and account facts. */
  complete(options: { code: string; redirectUri: string; codeVerifier: string; query: URLSearchParams }): Promise<NewConnection>;
}

/**
 * Your OAuth app (or bot) for one integration, such as `google.app({ clientId, clientSecret })`.
 * Register apps with `runtime({ apps })` so users can connect their accounts.
 */
export interface App {
  readonly integration: string;
  readonly oauth?: OAuthFlow;
}

/**
 * Thrown when a connection's tokens were revoked or expired for good. The runtime marks the
 * connection "needs-sign-in", stops reading it, and emits an error event with `needsSignIn`.
 */
export class SignInError extends Error {
  readonly needsSignIn = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SignInError";
  }
}

/** True for errors that mean the user has to sign in again. */
export function needsSignIn(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { needsSignIn?: unknown }).needsSignIn === true;
}

/**
 * The id a new connection gets: the integration and account, plus your user id when there is one
 * so that two of your users can connect the same account separately.
 */
export function connectionId(integration: string, account: string, userId?: string): string {
  return userId ? `${integration}:${userId}:${account}` : `${integration}:${account}`;
}

/** Drop the tokens. */
export function connectionInfo(connection: Connection): ConnectionInfo {
  const { credentials: _credentials, ...info } = connection;
  return info;
}

/** Build a connection from tokens you already have, for example from your own OAuth code. */
export function toConnection(
  integration: string,
  created: NewConnection,
  extra: { userId?: string; status?: ConnectionStatus; now?: Date } = {},
): Connection {
  const at = (extra.now ?? new Date()).toISOString();
  return {
    id: connectionId(integration, created.account, extra.userId),
    integration,
    ...(extra.userId ? { userId: extra.userId } : {}),
    label: created.label ?? created.account,
    credentials: created.credentials,
    ...(created.facts ? { facts: created.facts } : {}),
    status: extra.status ?? "active",
    createdAt: at,
    updatedAt: at,
  };
}
