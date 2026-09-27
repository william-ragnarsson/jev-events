import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Helix, TwitchApiError, TwitchAuthError, withTokens, type TwitchTokens } from "@jev-events/twitch";

import { BOT, CLIENT, fakeTwitch, STREAMER, type FakeTwitch } from "./fake-twitch.js";

// Helix, Twitch's API, as the signed-in account: renewing the token after a 401, waiting out rate
// limits, and what a refusal says.

let twitch: FakeTwitch;

beforeEach(async () => {
  twitch = await fakeTwitch();
});

afterEach(async () => {
  await twitch.close();
});

async function failure(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  if (!(error instanceof Error)) throw new Error("Expected it to fail.");
  return error;
}

/** Helix as the bot, and the tokens it renewed. */
function helixFor(options: { scopes?: string[] } = {}) {
  const renewed: TwitchTokens[] = [];
  const tokens = twitch.issue(BOT, options);
  const helix = new Helix(withTokens({ clientId: CLIENT.id, ...tokens }, (next) => void renewed.push(next)));
  return { helix, tokens, renewed };
}

const paths = () => twitch.calls().map((call) => call.path);
const USERS = "/helix/users";
/** Out of requests until now, so the wait is the shortest one. */
const rateLimited = () => ({ headers: { "Ratelimit-Remaining": "0", "Ratelimit-Reset": String(Math.floor(Date.now() / 1000)) } });

describe("Helix", () => {
  it("calls Twitch as the account, with the app's client ID", async () => {
    const { helix, tokens } = helixFor();

    expect(await helix.userByLogin("mychannel")).toEqual({ id: STREAMER.id, login: STREAMER.login, display_name: STREAMER.name });
    expect(await helix.userByLogin("nobodyhere")).toBeUndefined();
    expect(twitch.calls(USERS)).toMatchObject([
      { method: "GET", query: { login: "mychannel" }, token: tokens.accessToken },
      { method: "GET", query: { login: "nobodyhere" } },
    ]);
  });

  it("leaves out query values that aren't set, and returns nothing for an empty answer", async () => {
    const { helix } = helixFor();
    const answer = await helix.call("DELETE", "/moderation/chat", {
      query: { broadcaster_id: STREAMER.id, moderator_id: BOT.id, message_id: "msg-1", reason: undefined },
    });

    expect(answer).toBeUndefined();
    expect(twitch.calls("/helix/moderation/chat")).toMatchObject([{ query: { broadcaster_id: STREAMER.id, moderator_id: BOT.id, message_id: "msg-1" } }]);
    expect(twitch.calls("/helix/moderation/chat")[0]?.query).not.toHaveProperty("reason");
  });

  it("renews the token once after a 401 and tries again", async () => {
    const { helix, renewed } = helixFor();
    twitch.expireTokens();

    expect(await helix.userByLogin("mychannel")).toMatchObject({ id: STREAMER.id });
    expect(paths()).toEqual([USERS, "/oauth2/token", USERS]);
    expect(renewed).toHaveLength(1);
  });

  it("says the account was signed out when Twitch still says no after renewing", async () => {
    const { helix } = helixFor();
    twitch.fail(USERS, 401, "Invalid OAuth token", { times: 2 });
    const error = await failure(helix.userByLogin("mychannel"));

    expect(error).toBeInstanceOf(TwitchAuthError);
    expect(error.message).toBe("Twitch signed this account out (Invalid OAuth token): its token was revoked or expired.");
    expect(paths()).toEqual([USERS, "/oauth2/token", USERS]);
  });

  it("says the account was signed out when renewing fails", async () => {
    const { helix } = helixFor();
    twitch.revokeTokens();
    const error = await failure(helix.userByLogin("mychannel"));

    expect(error).toBeInstanceOf(TwitchAuthError);
    expect(error.message).toMatch(/^Twitch signed this account out \(Invalid refresh token\)/);
  });

  it("says which permission the account didn't allow, without renewing", async () => {
    const { helix } = helixFor({ scopes: ["user:read:chat"] });
    const error = await failure(helix.call("POST", "/clips", { query: { broadcaster_id: STREAMER.id } }));

    expect(error).toBeInstanceOf(TwitchApiError);
    expect(error).toMatchObject({ status: 401, detail: "Missing scope: clips:edit" });
    expect(error.message).toBe("Twitch POST /clips failed: the account hasn't allowed clips:edit. Sign in again and allow it.");
    expect(paths()).toEqual(["/helix/clips"]);
  });

  it("keeps Twitch's own words for a refusal", async () => {
    const { helix } = helixFor();
    twitch.fail(USERS, 503, "Service Unavailable");
    const error = await failure(helix.userByLogin("mychannel"));

    expect(error).toBeInstanceOf(TwitchApiError);
    expect(error).toMatchObject({ status: 503, detail: "Service Unavailable" });
    expect(error.message).toBe("Twitch GET /users failed (503): Service Unavailable");
  });

  it("waits out the rate limit and tries again", async () => {
    const { helix } = helixFor();
    twitch.fail(USERS, 429, "Too Many Requests", rateLimited());
    const started = Date.now();

    expect(await helix.userByLogin("mychannel")).toMatchObject({ id: STREAMER.id });
    expect(twitch.calls(USERS)).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
  });

  it("stops waiting after three tries", async () => {
    const { helix } = helixFor();
    twitch.fail(USERS, 429, "Too Many Requests", { times: 4, ...rateLimited() });
    const error = await failure(helix.userByLogin("mychannel"));

    expect(error).toMatchObject({ status: 429, message: "Twitch GET /users failed (429): Too Many Requests" });
    expect(twitch.calls(USERS)).toHaveLength(4);
  });

  it("doesn't wait on a limit that waiting won't fix, such as too many chat connections", async () => {
    const { helix } = helixFor();
    twitch.fail(USERS, 429, "websocket transports limit exceeded");
    const error = await failure(helix.userByLogin("mychannel"));

    expect(error).toMatchObject({ status: 429, detail: "websocket transports limit exceeded" });
    expect(twitch.calls(USERS)).toHaveLength(1);
  });

  it("still renews the token after waiting out a rate limit", async () => {
    const { helix } = helixFor();
    twitch.fail(USERS, 429, "Too Many Requests", rateLimited());
    twitch.expireTokens();

    expect(await helix.userByLogin("mychannel")).toMatchObject({ id: STREAMER.id });
    expect(paths()).toEqual([USERS, USERS, "/oauth2/token", USERS]);
  });
});
