import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { needsSignIn, silentLogger, toConnection, type App, type SessionContext } from "jev-events";
import { app, chat, connectedAuth, fromEnv, TwitchAuthError, withTokens, type TwitchTokens } from "@jev-events/twitch";

import { ALL_SCOPES, BOT, CLIENT, fakeTwitch, STREAMER, type FakeTwitch } from "./fake-twitch.js";
import { stopAll, streamer, waitFor } from "./helpers.js";

// Tokens against the fake Twitch: renewing them before they expire, what a used or revoked refresh
// token does, checking who a token belongs to, and the one account read from the environment.

let twitch: FakeTwitch;

beforeEach(async () => {
  for (const name of ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET", "TWITCH_ACCESS_TOKEN", "TWITCH_REFRESH_TOKEN"]) vi.stubEnv(name, undefined);
  twitch = await fakeTwitch();
});

afterEach(async () => {
  stopAll();
  vi.unstubAllEnvs();
  await twitch.close();
});

async function failure(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  if (!(error instanceof Error)) throw new Error("Expected it to fail.");
  return error;
}

const paths = () => twitch.calls().map((call) => call.path);

describe("withTokens", () => {
  it("uses a token that isn't about to expire as it is", async () => {
    const tokens = twitch.issue(BOT);
    const auth = withTokens({ clientId: CLIENT.id, ...tokens });

    expect(await auth.token()).toBe(tokens.accessToken);
    expect(paths()).toEqual([]);
  });

  it("renews a token that expires within a minute, and hands the new tokens to onRefresh", async () => {
    const tokens = twitch.issue(BOT, { expiresIn: 30 });
    const renewed: TwitchTokens[] = [];
    const auth = withTokens({ clientId: CLIENT.id, ...tokens }, (next) => void renewed.push(next));
    const token = await auth.token();

    expect(token).not.toBe(tokens.accessToken);
    expect(await auth.token()).toBe(token);
    expect(renewed).toEqual([{ clientId: CLIENT.id, accessToken: token, refreshToken: expect.stringMatching(/^refresh-/), expiresAt: expect.any(Number) }]);
    expect(renewed[0]?.refreshToken).not.toBe(tokens.refreshToken);
    expect(renewed[0]?.expiresAt).toBeGreaterThan(Date.now() + 3_600_000);
    expect(twitch.calls("/oauth2/token")).toMatchObject([
      { method: "POST", body: { grant_type: "refresh_token", refresh_token: tokens.refreshToken, client_id: CLIENT.id } },
    ]);
  });

  it("gets an access token when it only has a refresh token", async () => {
    const { refreshToken } = twitch.issue(BOT);
    const auth = withTokens({ clientId: CLIENT.id, refreshToken });

    expect(await auth.token()).toMatch(/^access-/);
    expect(paths()).toEqual(["/oauth2/token"]);
  });

  it("renews once when several calls need a new token at the same time", async () => {
    const auth = withTokens({ clientId: CLIENT.id, ...twitch.issue(BOT, { expiresIn: 30 }) });
    const tokens = await Promise.all([auth.token(), auth.token(), auth.token()]);

    expect(new Set(tokens).size).toBe(1);
    expect(paths()).toEqual(["/oauth2/token"]);
  });

  it("says the account has to sign in again once its refresh token was used", async () => {
    // Twitch's Public apps hand out refresh tokens that work once, so two processes sharing one can't both renew.
    const { refreshToken } = twitch.issue(BOT);
    await withTokens({ clientId: CLIENT.id, refreshToken }).token();
    const error = await failure(withTokens({ clientId: CLIENT.id, refreshToken }).token());

    expect(error).toBeInstanceOf(TwitchAuthError);
    expect(error.message).toBe(
      "Twitch signed this account out (Invalid refresh token): the sign-in was revoked or expired, or its refresh token was already used.",
    );
    expect(needsSignIn(error)).toBe(true);
  });

  it("sends a Confidential app's client secret", async () => {
    const { refreshToken } = twitch.issue(BOT);
    await withTokens({ clientId: CLIENT.id, clientSecret: CLIENT.secret, refreshToken }).refresh();

    expect(twitch.calls("/oauth2/token")).toMatchObject([{ body: { client_id: CLIENT.id, client_secret: CLIENT.secret } }]);
  });

  it("says when the app's client secret or ID is wrong, which signing in again won't fix", async () => {
    const { refreshToken } = twitch.issue(BOT);
    const secret = await failure(withTokens({ clientId: CLIENT.id, clientSecret: "wrong", refreshToken }).refresh());
    const id = await failure(withTokens({ clientId: "wrongclientid", refreshToken }).refresh());

    expect(secret.message).toBe(
      "Twitch wouldn't renew the token (invalid client secret): check the app's client secret in TWITCH_CLIENT_SECRET, or pass twitch.app({ clientSecret }).",
    );
    expect(id.message).toBe("Twitch doesn't accept the app's client ID (invalid client). Check TWITCH_CLIENT_ID.");
    expect([needsSignIn(secret), needsSignIn(id)]).toEqual([false, false]);
  });

  it("says when Twitch couldn't renew for now", async () => {
    twitch.fail("/oauth2/token", 503, "Service Unavailable");
    const error = await failure(withTokens({ clientId: CLIENT.id, ...twitch.issue(BOT) }).refresh());

    expect(error.message).toBe("Couldn't renew the Twitch token (503: Service Unavailable).");
    expect(needsSignIn(error)).toBe(false);
  });

  it("can't renew without a refresh token", async () => {
    const { accessToken } = twitch.issue(BOT);
    const error = await failure(withTokens({ clientId: CLIENT.id, accessToken }).refresh());

    expect(error).toBeInstanceOf(TwitchAuthError);
    expect(error.message).toBe("The Twitch sign-in expired and there's no refresh token to renew it.");
  });

  it("needs a client ID and a token", () => {
    const message = "Twitch auth needs a clientId and an access or refresh token.";
    expect(() => withTokens({ clientId: CLIENT.id })).toThrow(message);
    expect(() => withTokens({ clientId: "", accessToken: "access-1" })).toThrow(message);
  });
});

describe("identity and validate", () => {
  it("asks Twitch who the token belongs to once, then remembers", async () => {
    const tokens = twitch.issue(STREAMER);
    const auth = withTokens({ clientId: CLIENT.id, ...tokens });

    expect(await auth.identity()).toEqual({ userId: STREAMER.id, login: STREAMER.login, scopes: ALL_SCOPES });
    await auth.identity();
    expect(twitch.calls("/oauth2/validate")).toMatchObject([{ method: "GET", token: tokens.accessToken }]);

    // Twitch wants apps to check again every hour.
    await auth.validate();
    expect(twitch.calls("/oauth2/validate")).toHaveLength(2);
  });

  it("renews an expired token and asks again", async () => {
    const auth = withTokens({ clientId: CLIENT.id, ...twitch.issue(BOT) });
    twitch.expireTokens();

    expect(await auth.validate()).toMatchObject({ userId: BOT.id, login: BOT.login });
    expect(paths()).toEqual(["/oauth2/validate", "/oauth2/token", "/oauth2/validate"]);
  });

  it("says the account was signed out when its token is gone and there's no refresh token", async () => {
    const { accessToken } = twitch.issue(BOT);
    twitch.revokeTokens();
    const error = await failure(withTokens({ clientId: CLIENT.id, accessToken }).identity());

    expect(error).toBeInstanceOf(TwitchAuthError);
    expect(error.message).toBe("Twitch signed this account out: its token was revoked or expired.");
  });

  it("asks again after a failed check", async () => {
    const auth = withTokens({ clientId: CLIENT.id, ...twitch.issue(BOT) });
    twitch.fail("/oauth2/validate", 500, "Internal Server Error");

    expect((await failure(auth.identity())).message).toBe("Couldn't check the Twitch token (500).");
    expect(await auth.identity()).toMatchObject({ userId: BOT.id });
  });

  it("says when the token belongs to another app", async () => {
    const tokens = twitch.issue(BOT, { clientId: "otherclient0000000000000000000" });
    const error = await failure(withTokens({ clientId: CLIENT.id, ...tokens }).identity());

    expect(error.message).toBe(
      `The Twitch token was made for another app (client ID otherclient0000000000000000000), not ${CLIENT.id}. Use the client ID it was made with.`,
    );
  });
});

describe("twitch.fromEnv", () => {
  it("reads one account from TWITCH_ variables", () => {
    const connection = fromEnv({ TWITCH_CLIENT_ID: CLIENT.id, TWITCH_CLIENT_SECRET: "secret", TWITCH_ACCESS_TOKEN: "access-1", TWITCH_REFRESH_TOKEN: "refresh-1" });

    expect(connection).toMatchObject({
      id: "twitch:env",
      integration: "twitch",
      label: "TWITCH_ACCESS_TOKEN",
      status: "active",
      credentials: { clientId: CLIENT.id, clientSecret: "secret", accessToken: "access-1", refreshToken: "refresh-1" },
    });
  });

  it("takes a refresh token on its own", () => {
    const connection = fromEnv({ TWITCH_CLIENT_ID: CLIENT.id, TWITCH_REFRESH_TOKEN: "refresh-1" });

    expect(connection.label).toBe("TWITCH_REFRESH_TOKEN");
    expect(connection.credentials).toEqual({ clientId: CLIENT.id, refreshToken: "refresh-1" });
  });

  it("says which variables to set", () => {
    const message = "Set TWITCH_CLIENT_ID and TWITCH_ACCESS_TOKEN, plus TWITCH_REFRESH_TOKEN to renew it.";
    expect(() => fromEnv({})).toThrow(message);
    expect(() => fromEnv({ TWITCH_CLIENT_ID: CLIENT.id })).toThrow(message);
    expect(() => fromEnv({ TWITCH_ACCESS_TOKEN: "access-1" })).toThrow(message);
  });

  it("reads process.env by default, and reads chat as that account", async () => {
    const tokens = twitch.issue(STREAMER);
    vi.stubEnv("TWITCH_CLIENT_ID", CLIENT.id);
    vi.stubEnv("TWITCH_ACCESS_TOKEN", tokens.accessToken);
    vi.stubEnv("TWITCH_REFRESH_TOKEN", tokens.refreshToken);
    const run = streamer(chat(), { connection: fromEnv() });
    await run.start();
    twitch.chat("hello from the environment");
    await waitFor(() => run.items.length === 1);

    expect(await run.session()).toMatchObject({ login: STREAMER.login, channel: STREAMER.login, broadcasterId: STREAMER.id });
    expect(run.items.map((item) => item.text)).toEqual(["hello from the environment"]);
  });
});

describe("connected accounts", () => {
  const context = (appOption?: App): SessionContext => ({
    connection: undefined,
    app: appOption,
    log: silentLogger,
    signal: new AbortController().signal,
    saveCredentials: async () => {},
  });

  /** A saved connection without a secret, as sign-in makes them: the secret stays with the app. */
  const saved = () => toConnection("twitch", twitch.connection(BOT));
  const secretSent = () => (twitch.calls("/oauth2/token").at(-1)?.body as { client_secret?: string } | undefined)?.client_secret;

  it("renews with the secret of the app that made the tokens", async () => {
    await connectedAuth(context(app({ clientId: CLIENT.id, clientSecret: CLIENT.secret })), saved()).refresh();
    expect(secretSent()).toBe(CLIENT.secret);

    vi.stubEnv("TWITCH_CLIENT_ID", CLIENT.id);
    vi.stubEnv("TWITCH_CLIENT_SECRET", CLIENT.secret);
    await connectedAuth(context(), saved()).refresh();
    expect(secretSent()).toBe(CLIENT.secret);
  });

  it("doesn't send another app's secret", async () => {
    vi.stubEnv("TWITCH_CLIENT_ID", "anotherclientid");
    vi.stubEnv("TWITCH_CLIENT_SECRET", "another-secret");
    await connectedAuth(context(app({ clientId: "anotherclientid", clientSecret: "another-secret" })), saved()).refresh();

    expect(secretSent()).toBeUndefined();
  });
});
