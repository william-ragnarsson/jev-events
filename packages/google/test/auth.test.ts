import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectedApi, fromEnv, google as googleIntegration, GoogleAuthError, inbox, withTokens, type GoogleTokens } from "@jev-events/google";
import { toConnection, type App, type Connection, type Credentials, type SessionContext } from "jev-events";

import { fakeGoogle, type FakeGoogle } from "./fake-google.js";
import { checker } from "./helpers.js";

let google: FakeGoogle;

beforeEach(async () => {
  google = await fakeGoogle();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await google.close();
});

const SIGNED_OUT = "Google signed this account out: the sign-in expired or was revoked (apps in Testing mode are signed out after 7 days).";

describe("withTokens", () => {
  it("uses a fresh access token without asking Google", async () => {
    const tokens = google.tokens();
    const auth = withTokens(tokens);

    expect(await auth.token()).toBe(tokens.accessToken);
    expect(auth.clientId).toBe("client-1");
    expect(auth.email).toBe("me@acme.com");
    expect(google.requests).toEqual([]);
  });

  it("refreshes a token that expires within a minute, and hands the new tokens to onRefresh", async () => {
    const refreshed: GoogleTokens[] = [];
    const auth = withTokens({ ...google.tokens(), expiresAt: Date.now() + 30_000 }, (tokens) => void refreshed.push(tokens));

    expect(await auth.token()).toBe("access-2");
    expect(google.calls("POST /token")[0]?.body).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "client-1",
      client_secret: "secret-1",
    });
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toMatchObject({ clientId: "client-1", accessToken: "access-2", refreshToken: "refresh-1", email: "me@acme.com" });
    expect(refreshed[0]?.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);

    // Good for an hour now, so the next call doesn't refresh again.
    expect(await auth.token()).toBe("access-2");
    expect(google.calls("POST /token")).toHaveLength(1);
  });

  it("fetches an access token when it only has a refresh token", async () => {
    const auth = withTokens({ clientId: "client-1", clientSecret: "secret-1", refreshToken: "refresh-1" });

    expect(await auth.token()).toBe("access-1");
    expect(auth.email).toBeUndefined();
  });

  it("refreshes once when several calls need a token at the same time", async () => {
    const auth = withTokens({ clientId: "client-1", clientSecret: "secret-1", refreshToken: "refresh-1" });

    expect(await Promise.all([auth.token(), auth.token(), auth.refresh()])).toEqual(["access-1", "access-1", "access-1"]);
    expect(google.calls("POST /token")).toHaveLength(1);
  });

  it("says you were signed out when Google revoked the refresh token", async () => {
    google.revoke();
    const auth = withTokens({ clientId: "client-1", clientSecret: "secret-1", refreshToken: "refresh-1" });

    const error = await auth.token().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GoogleAuthError);
    expect((error as Error).message).toBe(SIGNED_OUT);
  });

  it("keeps using an access token it can't refresh, and asks for a new sign-in when told to refresh", async () => {
    google.tokens(); // issues access-1
    const auth = withTokens({ clientId: "client-1", accessToken: "access-1", expiresAt: Date.now() - 1_000 });

    expect(await auth.token()).toBe("access-1");
    const error = await auth.refresh().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GoogleAuthError);
    expect((error as Error).message).toBe("The Google sign-in expired and there's no refresh token to renew it.");
    expect(google.requests).toEqual([]);
  });

  it("needs a client ID and a token", () => {
    const message = "Google auth needs a clientId and an access or refresh token.";
    expect(() => withTokens({ clientId: "", refreshToken: "refresh-1" })).toThrow(message);
    expect(() => withTokens({ clientId: "client-1" })).toThrow(message);
  });

  it("explains a refresh that failed for another reason, without calling it a sign-out", async () => {
    const auth = () => withTokens({ clientId: "client-1", clientSecret: "secret-1", refreshToken: "refresh-1" });

    google.fail("POST /token", 500);
    const outage = await auth().token().catch((error: unknown) => error);
    expect(outage).not.toBeInstanceOf(GoogleAuthError);
    expect((outage as Error).message).toBe("Couldn't refresh the Google token (500 internal_failure).");

    google.fail("POST /token", 502, { body: "<html>Bad gateway</html>" });
    await expect(auth().token()).rejects.toThrow("Couldn't refresh the Google token (502).");

    const wrongSecret = withTokens({ clientId: "client-1", clientSecret: "not-the-secret", refreshToken: "refresh-1" });
    await expect(wrongSecret.token()).rejects.toThrow("Couldn't refresh the Google token (401 invalid_client).");
  });
});

describe("fromEnv", () => {
  it("builds a connection from the client and refresh token, which sources can read", async () => {
    google.deliver({ from: "Ann Smith <ann@example.com>", subject: "Lunch?", text: "Friday at 12?" });
    const connection = fromEnv({ GOOGLE_CLIENT_ID: "client-1", GOOGLE_CLIENT_SECRET: "secret-1", GOOGLE_REFRESH_TOKEN: "refresh-1" });
    const run = checker(inbox({ backfill: 1 }), { connection });

    await run.check();

    expect(connection).toMatchObject({ id: "google:env", integration: "google", label: "GOOGLE_REFRESH_TOKEN", status: "active" });
    expect(connection.credentials).toEqual({ clientId: "client-1", clientSecret: "secret-1", refreshToken: "refresh-1" });
    expect(run.items.map((item) => item.subject)).toEqual(["Lunch?"]);
    expect(run.saved.at(-1)?.accessToken).toMatch(/^access-/);
    expect(googleIntegration.fromEnv).toBe(fromEnv);
  });

  it("accepts an access token on its own", () => {
    const connection = fromEnv({ GOOGLE_CLIENT_ID: "client-1", GOOGLE_ACCESS_TOKEN: "access-from-env" });

    expect(connection.credentials).toEqual({ clientId: "client-1", accessToken: "access-from-env" });
  });

  it("says which variables to set", () => {
    const message = "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.";
    expect(() => fromEnv({})).toThrow(message);
    expect(() => fromEnv({ GOOGLE_CLIENT_ID: "client-1", GOOGLE_CLIENT_SECRET: "secret-1" })).toThrow(message);
    expect(() => fromEnv({ GOOGLE_REFRESH_TOKEN: "refresh-1" })).toThrow(message);
  });
});

describe("connectedApi", () => {
  /** A session context for `connection` that records the credentials it saves. */
  function sessionFor(connection: Connection, options: { app?: App; save?: (credentials: Credentials) => Promise<void> } = {}) {
    const saved: Credentials[] = [];
    const warnings: unknown[][] = [];
    const ctx: SessionContext = {
      connection,
      app: options.app,
      log: { debug: () => {}, info: () => {}, warn: (...args: unknown[]) => void warnings.push(args), error: () => {} },
      signal: new AbortController().signal,
      saveCredentials: options.save ?? (async (credentials) => void saved.push(credentials)),
    };
    return { ctx, saved, warnings };
  }

  it("calls Google with the connection's token, without renewing a fresh one", async () => {
    const connection = toConnection("google", google.connection());
    const { ctx, saved } = sessionFor(connection);

    const profile = await connectedApi(ctx, connection).gmail<{ emailAddress: string }>("GET", "/profile");

    expect(profile.emailAddress).toBe("me@acme.com");
    expect(google.calls("POST /token")).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("saves a renewed token back to the connection, keeping the rest of its credentials", async () => {
    const signedIn = google.connection();
    const connection = toConnection("google", { ...signedIn, credentials: { ...signedIn.credentials, expiresAt: Date.now() - 1_000, scopes: ["openid"] } });
    const { ctx, saved } = sessionFor(connection);

    await connectedApi(ctx, connection).gmail("GET", "/profile");

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ clientId: "client-1", clientSecret: "secret-1", accessToken: "access-2", refreshToken: "refresh-1", scopes: ["openid"] });
    expect(saved[0]?.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
  });

  it("renews with the registered app's client when the connection came from a web sign-in", async () => {
    const connection = toConnection("google", { account: "me@acme.com", credentials: { refreshToken: "refresh-1", scopes: ["openid"] } });
    const app = googleIntegration.app({ clientId: "client-1", clientSecret: "secret-1" });
    const { ctx, saved } = sessionFor(connection, { app });

    await connectedApi(ctx, connection).gmail("GET", "/profile");

    expect(google.calls("POST /token")[0]?.body).toMatchObject({ client_id: "client-1", client_secret: "secret-1", refresh_token: "refresh-1" });
    // The app's client isn't copied into the connection.
    expect(saved[0]).toEqual({ refreshToken: "refresh-1", scopes: ["openid"], accessToken: "access-1", expiresAt: expect.any(Number) });
  });

  it("falls back to GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "client-1");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret-1");
    const connection = toConnection("google", { account: "me@acme.com", credentials: { refreshToken: "refresh-1" } });
    const { ctx } = sessionFor(connection);

    await connectedApi(ctx, connection).gmail("GET", "/profile");

    expect(google.calls("POST /token")[0]?.body).toMatchObject({ client_id: "client-1", client_secret: "secret-1" });
  });

  it("says where to set the client when there's none to renew with", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    const connection = toConnection("google", { account: "me@acme.com", credentials: { refreshToken: "refresh-1" } });
    const { ctx } = sessionFor(connection);

    expect(() => connectedApi(ctx, connection)).toThrow(
      "Google needs your OAuth client to renew this account's token: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or pass runtime({ apps: [google.app({ clientId, clientSecret })] }).",
    );
  });

  it("asks for a new sign-in when the connection has no tokens", () => {
    const connection = toConnection("google", { account: "me@acme.com", credentials: { clientId: "client-1" } });
    const { ctx } = sessionFor(connection);

    expect(() => connectedApi(ctx, connection)).toThrow(GoogleAuthError);
    expect(() => connectedApi(ctx, connection)).toThrow("The Google connection me@acme.com has no tokens. Sign in again.");
  });

  it("keeps going with the renewed token when saving it fails", async () => {
    const signedIn = google.connection();
    const connection = toConnection("google", { ...signedIn, credentials: { ...signedIn.credentials, expiresAt: Date.now() - 1_000 } });
    const { ctx, warnings } = sessionFor(connection, {
      save: async () => {
        throw new Error("database is down");
      },
    });

    const profile = await connectedApi(ctx, connection).gmail<{ emailAddress: string }>("GET", "/profile");

    expect(profile.emailAddress).toBe("me@acme.com");
    expect(warnings).toEqual([["Couldn't save the renewed Google token:", new Error("database is down")]]);
  });
});
