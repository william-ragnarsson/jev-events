import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { needsSignIn, toConnection, type Connection } from "jev-events";

import { app, chat, TwitchApiError, TwitchAuthError, type TwitchChatOptions } from "@jev-events/twitch";

import { ALL_SCOPES, BOT, CLIENT, fakeTwitch, OTHER, STREAMER, VIEWER, type FakeTwitch } from "./fake-twitch.js";
import { connectionTo, pause, stopAll, streamer, waitFor } from "./helpers.js";

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

const SUBSCRIPTIONS = "/helix/eventsub/subscriptions";
const NIGHTBOT = { id: "19264788", login: "nightbot", name: "Nightbot" };

/** Chat read as `connection`, not started yet. Default: the bot reading the streamer's channel. */
function reading(channel: string | TwitchChatOptions = "mychannel", connection: Connection = connectionTo(twitch)) {
  const source = typeof channel === "string" ? chat(channel) : chat(channel);
  // Not spread: `ended` is a getter.
  return Object.assign(streamer(source, { connection }), { source });
}

/** Start reading and wait until chat is subscribed. */
async function watching(channel?: string | TwitchChatOptions, connection?: Connection) {
  const run = reading(channel, connection);
  await run.start();
  return run;
}

const texts = (items: Array<{ text: string }>) => items.map((item) => item.text);

async function failure(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error)) throw new Error("Expected it to fail.");
  return error;
}

describe("twitch.chat session", () => {
  it("reads the account's own channel when no channel is named", async () => {
    const run = reading({}, connectionTo(twitch, STREAMER));
    expect(run.source).toMatchObject({ id: "twitch:chat", platform: "twitch", integration: "twitch", noun: "message", canAct: true });

    const session = await run.session();
    expect(session).toMatchObject({ userId: STREAMER.id, login: STREAMER.login, channel: "mychannel", broadcasterId: STREAMER.id, scopes: ALL_SCOPES });
    // Twitch wants the token checked at start; the account's own channel needs no lookup.
    expect(twitch.calls().map((call) => call.path)).toEqual(["/oauth2/validate"]);
  });

  it("finds a channel by name, however it's written", async () => {
    const run = reading("#MyChannel");
    expect(run.source.id).toBe("twitch:chat:mychannel");
    expect(await run.session()).toMatchObject({ userId: BOT.id, login: BOT.login, channel: "mychannel", broadcasterId: STREAMER.id });
    expect(twitch.calls("/helix/users")).toMatchObject([{ query: { login: "mychannel" } }]);
  });

  it("says when there's no such channel", async () => {
    await expect(reading("nobodyhere").session()).rejects.toThrow("There's no Twitch channel called nobodyhere.");
    expect(() => chat("my channel")).toThrow(TypeError);
    expect(() => chat("my channel")).toThrow('"my channel" is not a valid Twitch channel name.');
  });

  it("needs a connection, and says how to get one", async () => {
    await expect(streamer(chat()).session()).rejects.toThrow(
      'twitch:chat reads chat as a signed-in Twitch account, so it needs a connection. Sign in with npx jev-events auth twitch, or pass connections to start(). To read a channel without signing in, use twitchChat("<channel>") from jev-events/public.',
    );
  });

  it("asks for a new sign-in when the account didn't allow reading chat", async () => {
    const error = await failure(reading("mychannel", connectionTo(twitch, BOT, { scopes: ["user:write:chat"] })).session());
    expect(error).toBeInstanceOf(TwitchAuthError);
    expect(error.message).toBe("The Twitch account jevbot hasn't allowed reading chat (the user:read:chat scope). Sign in again and allow it.");
    expect(needsSignIn(error)).toBe(true);
  });

  it("asks for a new sign-in when the connection has no tokens", async () => {
    const connection = toConnection("twitch", { account: BOT.id, label: BOT.login, credentials: { clientId: CLIENT.id } });
    const error = await failure(reading("mychannel", connection).session());
    expect(error).toBeInstanceOf(TwitchAuthError);
    expect(error.message).toBe("The Twitch connection jevbot has no tokens. Sign in again.");
  });

  it("says when the token belongs to another app", async () => {
    const { accessToken } = twitch.issue(BOT, { clientId: "otherclient0000000000000000000" });
    const connection = toConnection("twitch", { account: BOT.id, label: BOT.login, credentials: { clientId: CLIENT.id, accessToken } });
    await expect(reading("mychannel", connection).session()).rejects.toThrow(
      `The Twitch token was made for another app (client ID otherclient0000000000000000000), not ${CLIENT.id}. Use the client ID it was made with.`,
    );
  });

  it("takes the Client ID from the app, else TWITCH_CLIENT_ID, when the connection has none", async () => {
    const { accessToken, refreshToken } = twitch.issue(BOT);
    const connection = toConnection("twitch", { account: BOT.id, label: BOT.login, credentials: { accessToken, refreshToken } });

    await expect(reading("mychannel", connection).session()).rejects.toThrow(
      "Twitch needs your app's Client ID to use this account's token: set TWITCH_CLIENT_ID, or pass runtime({ apps: [twitch.app({ clientId })] }). It's under Manage at https://dev.twitch.tv/console/apps",
    );
    const withApp = streamer(chat("mychannel"), { connection, app: app({ clientId: CLIENT.id }) });
    expect(await withApp.session()).toMatchObject({ login: BOT.login });

    vi.stubEnv("TWITCH_CLIENT_ID", CLIENT.id);
    expect(await reading("mychannel", connection).session()).toMatchObject({ login: BOT.login });
  });

  it("renews a token that's about to expire, and saves the new one", async () => {
    const connection = connectionTo(twitch, BOT, { expiresIn: 30 });
    const run = reading("mychannel", connection);
    await run.session();

    expect(run.saved).toHaveLength(1);
    const [renewed] = run.saved;
    expect(renewed).toMatchObject({ clientId: CLIENT.id });
    expect(renewed?.accessToken).not.toBe(connection.credentials.accessToken);
    expect(renewed?.refreshToken).not.toBe(connection.credentials.refreshToken);
    expect(Number(renewed?.expiresAt)).toBeGreaterThan(Date.now() + 3_600_000);
    // A Public app's refresh token works once, which is why the renewed one is saved.
    expect(twitch.spent.has(String(connection.credentials.refreshToken))).toBe(true);
  });

  it("renews a token Twitch stopped taking", async () => {
    const connection = connectionTo(twitch);
    twitch.expireTokens(BOT);
    const run = reading("mychannel", connection);

    expect(await run.session()).toMatchObject({ login: BOT.login });
    expect(run.saved).toHaveLength(1);
    expect(twitch.calls("/oauth2/validate")).toHaveLength(2);
  });

  it("asks for a new sign-in when the account took back the app's access", async () => {
    const connection = connectionTo(twitch);
    twitch.revokeTokens(BOT);
    const error = await failure(reading("mychannel", connection).session());
    expect(error).toBeInstanceOf(TwitchAuthError);
    expect(error.message).toBe(
      "Twitch signed this account out (Invalid refresh token): the sign-in was revoked or expired, or its refresh token was already used.",
    );
  });
});

describe("twitch.chat", () => {
  it("subscribes to the channel's chat over EventSub and emits new messages", async () => {
    const run = await watching();
    // Chat has no history, so a run() is done once it's listening.
    expect(run.ended).toBe(true);
    expect(twitch.calls(SUBSCRIPTIONS).map((call) => call.body)).toEqual([
      {
        type: "channel.chat.message",
        version: "1",
        condition: { broadcaster_user_id: STREAMER.id, user_id: BOT.id },
        transport: { method: "websocket", session_id: "session-1" },
      },
    ]);

    const id = twitch.chat("hello chat", { badges: ["subscriber"], first: true });
    await waitFor(() => run.items.length === 1);
    expect(run.items[0]).toMatchObject({
      id,
      text: "hello chat",
      author: { id: VIEWER.id, name: VIEWER.name, login: VIEWER.login, roles: ["subscriber"] },
      channel: "mychannel",
      channelId: STREAMER.id,
      firstMessage: true,
      facts: { firstMessage: true },
    });
    expect(run.errors).toEqual([]);
  });

  it("reads only its channel, and not the account's own messages", async () => {
    const run = await watching();
    twitch.chat("somewhere else", { channel: OTHER });
    twitch.chat("sent by the bot", { from: BOT });
    twitch.chat("hello");
    await waitFor(() => run.items.length === 1);
    await pause(50);
    expect(texts(run.items)).toEqual(["hello"]);
  });

  it("skips commands and well-known bots, unless told otherwise", async () => {
    const skipping = await watching();
    const keeping = await watching({ channel: "mychannel", ignore: { commands: false, bots: false } });
    twitch.chat("!uptime");
    twitch.chat("Follow the channel!", { from: NIGHTBOT });
    twitch.chat("hello");
    await waitFor(() => skipping.items.length === 1 && keeping.items.length === 3);
    expect(texts(skipping.items)).toEqual(["hello"]);
    expect(texts(keeping.items)).toEqual(["!uptime", "Follow the channel!", "hello"]);
  });

  it("emits a message Twitch sends twice only once", async () => {
    const run = await watching();
    twitch.chat("once", { eventsubId: "eventsub-same" });
    twitch.chat("once", { eventsubId: "eventsub-same" });
    twitch.chat("after");
    await waitFor(() => run.items.length === 2);
    await pause(50);
    expect(texts(run.items)).toEqual(["once", "after"]);
  });

  it("reconnects when the connection drops, and subscribes again", async () => {
    const run = await watching();
    twitch.drop();
    await waitFor(() => twitch.subscriptions === 1 && twitch.calls(SUBSCRIPTIONS).length === 2, 3_000, "a new subscription");

    expect(run.warnings).toHaveLength(1);
    expect(run.warnings[0]).toMatch(/^twitch: the chat connection closed \(\d+\)\. Reconnecting\.$/);
    expect(run.infos).toEqual(["twitch: reconnecting to chat in 1s."]);
    expect(twitch.calls(SUBSCRIPTIONS).map((call) => (call.body as { transport: { session_id: string } }).transport.session_id)).toEqual([
      "session-1",
      "session-2",
    ]);
    expect(twitch.connections).toEqual(["open 1", "close 1", "open 2"]);

    twitch.chat("back again");
    await waitFor(() => run.items.length === 1);
    expect(run.errors).toEqual([]);
  });

  it("keeps trying when reconnecting fails, waiting longer each time", async () => {
    const run = await watching();
    twitch.fail(SUBSCRIPTIONS, 500, "Internal Server Error");
    twitch.drop();
    // The first try fails, the second works.
    await waitFor(() => twitch.subscriptions === 1 && twitch.calls(SUBSCRIPTIONS).length === 3, 6_000, "a new subscription");

    expect(run.infos).toEqual(["twitch: reconnecting to chat in 1s.", "twitch: reconnecting to chat in 2s."]);
    expect(run.errors).toHaveLength(1);
    expect(run.errors[0]?.fatal).toBe(false);
    expect(run.errors[0]?.error).toBeInstanceOf(TwitchApiError);
    expect((run.errors[0]?.error as Error).message).toBe("Twitch POST /eventsub/subscriptions failed (500): Internal Server Error");

    twitch.chat("made it");
    await waitFor(() => run.items.length === 1);
  }, 10_000);

  it("moves when Twitch asks, without subscribing again", async () => {
    const run = await watching();
    twitch.reconnect();
    await waitFor(() => twitch.connections.length === 3, 2_000, "the move");

    // The new connection opens, and the old one closes only once the new one is welcomed.
    expect(twitch.connections).toEqual(["open 1", "open 2", "close 1"]);
    expect(run.infos).toEqual(["twitch: Twitch asked to move the chat connection. Moving."]);
    expect(twitch.calls(SUBSCRIPTIONS)).toHaveLength(1);

    twitch.chat("after the move");
    await waitFor(() => run.items.length === 1);
    expect(run.warnings).toEqual([]);
  });

  it("reconnects when the connection goes quiet", async () => {
    await twitch.close();
    twitch = await fakeTwitch({ keepalive: 0.5 });
    const run = await watching();
    twitch.silence();
    await waitFor(() => run.warnings.length === 1, 2_000, "the warning");
    expect(run.warnings).toEqual(["twitch: the chat connection went quiet for 0.5s. Reconnecting."]);

    twitch.speak();
    await waitFor(() => twitch.subscriptions === 1 && twitch.calls(SUBSCRIPTIONS).length === 2, 3_000, "a new subscription");
    twitch.chat("awake");
    await waitFor(() => run.items.length === 1);
  }, 10_000);

  it.each([
    ["authorization_revoked", BOT, "jevbot took back the app's access on Twitch, so it can't read #mychannel's chat anymore (authorization_revoked).", true],
    ["user_removed", BOT, "The account jevbot or the channel #mychannel no longer exists on Twitch (user_removed).", false],
    ["user_removed", STREAMER, "The account mychannel no longer exists on Twitch (user_removed).", false],
    ["chat_user_banned", BOT, "jevbot is banned from #mychannel's chat, so it can't read it anymore (chat_user_banned).", false],
    ["version_removed", BOT, "Twitch retired this chat subscription (version_removed). Update @jev-events/twitch.", false],
    ["moderator_removed", BOT, "Twitch stopped sending #mychannel's chat (moderator_removed).", false],
  ])("stops when Twitch ends the subscription (%s, as %s)", async (status, user, message, signIn) => {
    const run = await watching(user === STREAMER ? {} : "mychannel", connectionTo(twitch, user));
    twitch.revoke(status, user);
    await waitFor(() => run.errors.length === 1);

    expect(run.errors[0]?.fatal).toBe(true);
    expect((run.errors[0]?.error as Error).message).toBe(message);
    expect(needsSignIn(run.errors[0]?.error)).toBe(signIn);
    await waitFor(() => twitch.sockets === 0);
    await pause(50);
    expect(twitch.connections).toEqual(["open 1", "close 1"]);
  });

  it("says when the account already reads chat 3 times, Twitch's limit", async () => {
    for (let i = 0; i < 3; i++) await watching();
    const fourth = reading();
    await expect(fourth.start()).rejects.toThrow(
      "Twitch allows 3 chat connections per account and app, and jevbot is already using them (websocket transports limit exceeded). Stop another monitor or jev-events watch that reads chat as jevbot, then try again.",
    );
    await waitFor(() => twitch.sockets === 3);
    expect(fourth.ended).toBe(false);
  });

  it("fails to start when Twitch won't subscribe", async () => {
    twitch.fail(SUBSCRIPTIONS, 500, "Internal Server Error");
    const run = reading();
    await expect(run.start()).rejects.toThrow("Twitch POST /eventsub/subscriptions failed (500): Internal Server Error");
    await waitFor(() => twitch.sockets === 0);
    expect(run.ended).toBe(false);
  });

  it("renews the token when it has to subscribe again", async () => {
    const run = await watching();
    twitch.expireTokens(BOT);
    twitch.drop();
    await waitFor(() => twitch.subscriptions === 1 && run.saved.length === 1, 3_000, "a renewed subscription");

    twitch.chat("still here");
    await waitFor(() => run.items.length === 1);
    expect(run.errors).toEqual([]);
  });

  it("stops reconnecting once the account is signed out", async () => {
    const run = await watching();
    twitch.revokeTokens(BOT);
    twitch.drop();
    await waitFor(() => run.errors.length === 1, 3_000, "the error");

    expect(run.errors[0]?.error).toBeInstanceOf(TwitchAuthError);
    expect(needsSignIn(run.errors[0]?.error)).toBe(true);
    await pause(1_500);
    expect(twitch.connections).toEqual(["open 1", "close 1", "open 2", "close 2"]);
    expect(run.infos).toEqual(["twitch: reconnecting to chat in 1s."]);
  }, 10_000);

  it("closes the connection when it's stopped, and doesn't reconnect", async () => {
    const run = await watching();
    run.stop();
    await waitFor(() => twitch.sockets === 0);
    await pause(1_200);
    expect(twitch.connections).toEqual(["open 1", "close 1"]);
    expect(run.warnings).toEqual([]);
  });
});
