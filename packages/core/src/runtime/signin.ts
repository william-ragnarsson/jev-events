import { createHash, randomBytes } from "node:crypto";

import type { JsonValue } from "@typesafe-ai/sdk";

import { toConnection, type App, type Connection } from "../connection.js";
import type { Logger } from "../logger.js";
import { storeKey, type Store } from "../store/types.js";
import { json, page, redirect } from "./http.js";

export interface ConnectOptions {
  /** Your product's id for the user who is connecting. Saved on the connection as `userId`. */
  userId?: string;
  /** A path on your site to send them back to afterwards, such as "/settings". */
  returnTo?: string;
  /** Scopes to ask for on top of what the integration needs. */
  scopes?: readonly string[];
}

export interface SignInOptions {
  /**
   * Who is signed in to your product for this request, from your session cookie. Resolve
   * undefined when nobody is, and the connect link answers 401.
   */
  user?(request: Request): string | undefined | Promise<string | undefined>;
}

export interface SignInHost {
  readonly store: Store;
  readonly baseUrl: string | undefined;
  readonly log: Logger;
  app(integration: string): App | undefined;
  connect(connection: Connection): Promise<void>;
}

interface Pending {
  integration: string;
  userId?: string;
  returnTo?: string;
  verifier: string;
  redirectUri: string;
}

/** How long someone has to finish signing in. */
const SIGN_IN_MS = 10 * 60_000;

/** The provider's consent page for a new connection, with PKCE and a one-time state. */
export async function connectUrl(
  host: SignInHost,
  integration: string,
  options: ConnectOptions = {},
  base: string | undefined = host.baseUrl,
): Promise<string> {
  const app = host.app(integration);
  if (!app) throw new Error(`No app registered for ${integration}. Pass runtime({ apps: [${integration}.app({ ... })] }).`);
  if (!app.oauth) throw new Error(`The ${integration} app has no sign-in flow. Save a connection with runtime.connect() instead.`);
  if (!base) {
    throw new Error("Set baseUrl (or JEV_EVENTS_URL) to where jev.handle is mounted, such as https://example.com/api/jev.");
  }
  if (options.returnTo !== undefined && !isLocalPath(options.returnTo)) {
    throw new TypeError("returnTo must be a path on your site, such as /settings.");
  }

  const verifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const redirectUri = `${base.replace(/\/+$/, "")}/callback/${encodeURIComponent(integration)}`;
  const pending: Pending = {
    integration,
    ...(options.userId ? { userId: options.userId } : {}),
    ...(options.returnTo ? { returnTo: options.returnTo } : {}),
    verifier,
    redirectUri,
  };
  await host.store.set(storeKey("signin", state), pending as unknown as JsonValue, { ttlMs: SIGN_IN_MS });
  return app.oauth.authorizeUrl({ redirectUri, state, codeChallenge, ...(options.scopes ? { scopes: options.scopes } : {}) });
}

/** The callback route: trade the code for tokens and save the connection. */
export async function finishSignIn(host: SignInHost, request: Request, integration: string): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const state = query.get("state");
  const key = state ? storeKey("signin", state) : undefined;
  const pending = key ? ((await host.store.get(key)) as Pending | undefined) : undefined;
  if (!key || !pending || pending.integration !== integration) return page(400, "This sign-in link expired. Start again.");
  await host.store.delete(key);

  const back = (params: Record<string, string>) => (pending.returnTo ? redirect(withParams(pending.returnTo, params)) : undefined);
  const code = query.get("code");
  if (query.get("error") || !code) return back({ connect_error: "cancelled" }) ?? page(400, "Sign-in was cancelled.");

  const oauth = host.app(integration)?.oauth;
  if (!oauth) return page(500, `No app is registered for ${integration} any more.`);
  let connection: Connection;
  try {
    const created = await oauth.complete({ code, redirectUri: pending.redirectUri, codeVerifier: pending.verifier, query });
    connection = toConnection(integration, created, pending.userId ? { userId: pending.userId } : {});
    await host.connect(connection);
  } catch (error) {
    host.log.error(`couldn't finish signing in to ${integration}:`, error);
    return back({ connect_error: "failed" }) ?? page(502, `Couldn't finish signing in: ${message(error)}`);
  }
  return back({ connected: integration }) ?? page(200, `Connected ${connection.label ?? connection.id}. You can close this tab.`);
}

/** The connect route: send the signed-in user to the provider. Off unless `signIn.user` is set. */
export async function startSignIn(
  host: SignInHost,
  request: Request,
  integration: string,
  signIn: SignInOptions | undefined,
): Promise<Response> {
  if (!signIn?.user) {
    return json(404, {
      error: "Sign-in links are off. Pass signIn: { user } to runtime() to turn them on, or call jev.connectUrl() from your own route.",
    });
  }
  const userId = await signIn.user(request);
  if (!userId) return json(401, { error: "Sign in to your account first." });

  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo");
  const mounted = url.pathname.slice(0, url.pathname.lastIndexOf("/connect/"));
  try {
    const location = await connectUrl(
      host,
      integration,
      { userId, ...(returnTo && isLocalPath(returnTo) ? { returnTo } : {}) },
      host.baseUrl ?? `${url.origin}${mounted}`,
    );
    return redirect(location);
  } catch (error) {
    return json(400, { error: message(error) });
  }
}

/** Only paths on this site, so a link can't send people somewhere else after signing in. */
function isLocalPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
}

function withParams(path: string, params: Record<string, string>): string {
  const hashAt = path.indexOf("#");
  const hash = hashAt === -1 ? "" : path.slice(hashAt);
  const base = hashAt === -1 ? path : path.slice(0, hashAt);
  return `${base}${base.includes("?") ? "&" : "?"}${new URLSearchParams(params).toString()}${hash}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
