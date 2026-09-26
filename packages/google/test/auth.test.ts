import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fromEnv, fromFile, GoogleAuthError, withTokens, type GoogleTokens } from "@jev-events/google";
import { readCredentials, writeCredentials } from "jev-events";

import { fakeGoogle, type FakeGoogle } from "./fake-google.js";

let google: FakeGoogle;

beforeEach(async () => {
  google = await fakeGoogle();
});

afterEach(async () => {
  await google.close();
});

/** A credentials file in a fresh temporary folder. */
function credentialsPath(): string {
  return join(realpathSync(mkdtempSync(join(tmpdir(), "jev-google-"))), ".jev-events", "credentials.json");
}

const SIGNED_OUT =
  "Google signed you out: the sign-in expired or was revoked. Sign in again: npx jev-events auth google (apps in Testing mode are signed out after 7 days)";

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
    const auth = withTokens({ ...google.tokens(), expiresAt: Date.now() + 30_000 }, (tokens) => refreshed.push(tokens));

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
    expect((error as Error).message).toBe("The Google sign-in expired and there's no refresh token. Sign in again: npx jev-events auth google");
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
  it("reads the client and refresh token", async () => {
    const auth = fromEnv({ GOOGLE_CLIENT_ID: "client-1", GOOGLE_CLIENT_SECRET: "secret-1", GOOGLE_REFRESH_TOKEN: "refresh-1" });

    expect(auth.clientId).toBe("client-1");
    expect(await auth.token()).toBe("access-1");
  });

  it("accepts an access token on its own", async () => {
    const auth = fromEnv({ GOOGLE_CLIENT_ID: "client-1", GOOGLE_ACCESS_TOKEN: "access-from-env" });

    expect(await auth.token()).toBe("access-from-env");
    expect(google.requests).toEqual([]);
  });

  it("says which variables to set", () => {
    const message = "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.";
    expect(() => fromEnv({})).toThrow(message);
    expect(() => fromEnv({ GOOGLE_CLIENT_ID: "client-1", GOOGLE_CLIENT_SECRET: "secret-1" })).toThrow(message);
    expect(() => fromEnv({ GOOGLE_REFRESH_TOKEN: "refresh-1" })).toThrow(message);
  });
});

describe("fromFile", () => {
  const CONNECT_FIRST = "Connect your Google account first: npx jev-events auth google";

  it("asks you to connect when nothing is saved", () => {
    const path = credentialsPath();

    expect(() => fromFile(path)).toThrow(GoogleAuthError);
    expect(() => fromFile(path)).toThrow(CONNECT_FIRST);
  });

  it("asks you to connect when the saved sign-in has no tokens", () => {
    const path = credentialsPath();
    writeCredentials("google", { clientId: "client-1", clientSecret: "secret-1" }, path);

    expect(() => fromFile(path)).toThrow(CONNECT_FIRST);
  });

  it("says when the file isn't valid JSON", () => {
    const path = credentialsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json");

    expect(() => fromFile(path)).toThrow(`Couldn't read ${path}`);
  });

  it("writes refreshed tokens back, keeping the rest of the file", async () => {
    const path = credentialsPath();
    writeCredentials("twitch", { accessToken: "twitch-token" }, path);
    writeCredentials("google", { ...google.tokens(), expiresAt: Date.now() - 1_000, scopes: ["openid"] }, path);

    const auth = fromFile(path);
    expect(auth.email).toBe("me@acme.com");
    expect(await auth.token()).toBe("access-2");

    const saved = readCredentials<GoogleTokens>("google", path);
    expect(saved).toMatchObject({ clientId: "client-1", accessToken: "access-2", refreshToken: "refresh-1", email: "me@acme.com", scopes: ["openid"] });
    expect(saved?.expiresAt).toBeGreaterThan(Date.now());
    expect(readCredentials("twitch", path)).toEqual({ accessToken: "twitch-token" });

    // The next run reads the refreshed token and doesn't refresh again.
    expect(await fromFile(path).token()).toBe("access-2");
    expect(google.calls("POST /token")).toHaveLength(1);
  });
});
