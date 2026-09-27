import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectionId, memoryStore, monitor, noul, silentLogger, type ActionEvent, type ErrorEvent } from "jev-events";
import { twitchChat } from "jev-events/public";
import { mockJev } from "jev-events/testing";
import {
  ban,
  chat,
  clip,
  deleteMessage,
  reply,
  say,
  timeout,
  warn,
  type TwitchChatItem,
  type TwitchSession,
} from "@jev-events/twitch";

import { BOT, fakeTwitch, OTHER, STREAMER, VIEWER, type ChatOptions, type FakeTwitch } from "./fake-twitch.js";
import { connectionTo, firedOn, stopAll, streamer, waitFor, type Streamer } from "./helpers.js";

// Every native Twitch action against the fake Twitch: what it asks Helix for, what Twitch then
// has, and how refusals read. The end of the file runs them the way people do, in a monitor.

let twitch: FakeTwitch;
let run: Streamer<TwitchChatItem, TwitchSession> | undefined;

beforeEach(async () => {
  for (const name of ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET", "TWITCH_ACCESS_TOKEN", "TWITCH_REFRESH_TOKEN"]) vi.stubEnv(name, undefined);
  twitch = await fakeTwitch();
  run = undefined;
});

afterEach(async () => {
  stopAll();
  vi.unstubAllEnvs();
  await twitch.close();
});

const A_MOD = { id: "55", login: "amod", name: "AMod" };

/** A chat item that no source emitted, for what doesn't need Twitch. */
const EXAMPLE: TwitchChatItem = {
  id: "msg-example",
  text: "you're awful",
  at: new Date("2026-09-27T20:00:00Z"),
  channel: "mychannel",
  channelId: STREAMER.id,
  firstMessage: false,
  author: { id: VIEWER.id, name: VIEWER.name, login: VIEWER.login, roles: [] },
};

/** Chat read as `user`, listening. Default: the bot, which moderates #mychannel. No channel: the account's own. */
async function reading(channel: string | undefined = "mychannel", user: { id: string; login: string } = BOT, scopes?: string[]) {
  const reader = streamer(channel ? chat(channel) : chat(), { connection: connectionTo(twitch, user, scopes ? { scopes } : {}) });
  await reader.start();
  return reader;
}

/** Someone chats; returns the item the source emits for it, and what an action gets. Default: in #mychannel, read as the bot. */
async function said(text: string, options: ChatOptions = {}, reader?: Streamer<TwitchChatItem, TwitchSession>) {
  const current = reader ?? (run ??= await reading());
  const before = current.items.length;
  twitch.chat(text, options);
  await waitFor(() => current.items.length > before, 2_000, "the message");
  return { item: current.items[before]!, ctx: await current.actionContext(), reader: current };
}

describe("twitch.timeout", () => {
  it("times the chatter out for ten minutes, saying what fired in the mod log", async () => {
    const { item, ctx } = await said("you're awful");
    const action = timeout();
    await action.run(firedOn(item, "hateful"), ctx);

    expect(twitch.bans).toEqual([{ broadcasterId: STREAMER.id, moderatorId: BOT.id, userId: VIEWER.id, duration: 600, reason: "jev-events: hateful (93%)" }]);
    expect(twitch.calls("/helix/moderation/bans")).toMatchObject([
      {
        method: "POST",
        query: { broadcaster_id: STREAMER.id, moderator_id: BOT.id },
        body: { data: { user_id: VIEWER.id, duration: 600, reason: "jev-events: hateful (93%)" } },
      },
    ]);
    expect(action.describe(firedOn(item))).toBe("timeout Viewer for 600s");
  });

  it("takes how long, and a reason made from what fired", async () => {
    const { item, ctx } = await said("buy followers at spam.example");
    await timeout({ seconds: 60, reason: (event) => `${event.trigger.event}: "${event.item.text}"` }).run(firedOn(item, "spam"), ctx);

    expect(twitch.bans).toMatchObject([{ userId: VIEWER.id, duration: 60, reason: 'spam: "buy followers at spam.example"' }]);
  });

  it("lasts 1 second to two weeks", () => {
    for (const seconds of [0, 1.5, 1_209_601]) {
      expect(() => timeout({ seconds })).toThrow(new RangeError("A Twitch timeout lasts 1 to 1,209,600 seconds (two weeks)."));
    }
    expect(timeout({ seconds: 1_209_600 }).describe(firedOn(EXAMPLE))).toBe("timeout Viewer for 1209600s");
  });

  it("says how to make the account a moderator when it isn't one", async () => {
    const { item, ctx } = await said("you're awful", { channel: OTHER }, await reading("otherchannel"));
    await expect(timeout().run(firedOn(item), ctx)).rejects.toThrow(
      "jevbot isn't a moderator in #otherchannel. The broadcaster can make it one by typing in chat: /mod jevbot",
    );
    expect(twitch.bans).toEqual([]);

    twitch.mod(BOT, OTHER);
    await timeout().run(firedOn(item), ctx);
    expect(twitch.bans).toMatchObject([{ broadcasterId: OTHER.id, moderatorId: BOT.id, userId: VIEWER.id }]);
  });

  it("works for broadcasters in their own channel", async () => {
    const { item, ctx } = await said("you're awful", {}, await reading(undefined, STREAMER));
    await timeout().run(firedOn(item), ctx);

    expect(twitch.bans).toMatchObject([{ broadcasterId: STREAMER.id, moderatorId: STREAMER.id, userId: VIEWER.id }]);
  });
});

describe("twitch.ban", () => {
  it("bans the chatter, and banning them again is fine", async () => {
    const { item, ctx } = await said("you're awful");
    const action = ban();
    await action.run(firedOn(item, "hateful"), ctx);
    await action.run(firedOn(item, "hateful"), ctx);

    expect(twitch.bans).toEqual([{ broadcasterId: STREAMER.id, moderatorId: BOT.id, userId: VIEWER.id, reason: "jev-events: hateful (93%)" }]);
    expect(twitch.calls("/helix/moderation/bans")).toHaveLength(2);
    expect(action.describe(firedOn(item))).toBe("ban Viewer");
  });

  it("passes on Twitch's refusal to ban a moderator", async () => {
    twitch.mod(A_MOD);
    const { item, ctx } = await said("you're awful", { from: A_MOD, badges: ["moderator"] });

    await expect(ban().run(firedOn(item), ctx)).rejects.toThrow(
      "Twitch POST /moderation/bans failed (400): The user specified in the user_id field may not be banned.",
    );
  });
});

describe("twitch.deleteMessage", () => {
  it("deletes the message, and deleting it again is fine", async () => {
    const { item, ctx } = await said("you're awful");
    const action = deleteMessage();
    await action.run(firedOn(item), ctx);
    await action.run(firedOn(item), ctx);

    expect(twitch.deleted).toEqual([item.id]);
    expect(twitch.calls("/helix/moderation/chat")).toMatchObject([
      { method: "DELETE", query: { broadcaster_id: STREAMER.id, moderator_id: BOT.id, message_id: item.id } },
      { method: "DELETE", query: { message_id: item.id } },
    ]);
    expect(action.describe(firedOn(item))).toBe("delete the message from Viewer");
  });
});

describe("twitch.warn", () => {
  it("warns the chatter, with a reason they see", async () => {
    const { item, ctx } = await said("you're awful");
    await warn({ reason: "Please keep it civil." }).run(firedOn(item), ctx);
    await warn().run(firedOn(item, "rude"), ctx);

    expect(twitch.warnings).toEqual([
      { userId: VIEWER.id, reason: "Please keep it civil." },
      { userId: VIEWER.id, reason: "jev-events: rude (93%)" },
    ]);
    expect(twitch.calls("/helix/moderation/warnings")).toMatchObject([{ query: { broadcaster_id: STREAMER.id, moderator_id: BOT.id } }, {}]);
    expect(warn().describe(firedOn(item))).toBe("warn Viewer");
  });
});

describe("twitch.reply and twitch.say", () => {
  it("replies to the message, and doesn't read its own reply as chat", async () => {
    const { item, ctx, reader } = await said("when does the stream start?");
    const action = reply("At 8pm CET.");
    await action.run(firedOn(item, "question"), ctx);
    await said("thanks!");

    expect(twitch.sent).toEqual([{ broadcasterId: STREAMER.id, senderId: BOT.id, message: "At 8pm CET.", replyTo: item.id }]);
    // Twitch sent the reply back over chat, before "thanks!".
    expect(reader.items.map((each) => each.text)).toEqual(["when does the stream start?", "thanks!"]);
    expect(action.describe(firedOn(item))).toBe('reply to Viewer: "At 8pm CET."');
  });

  it("makes the text from what fired", async () => {
    const { item, ctx } = await said("you're awful");
    await reply((event) => `@${event.item.author.name} please don't, that's ${event.trigger.event}.`).run(firedOn(item, "rude"), ctx);

    expect(twitch.sent.map((sent) => sent.message)).toEqual(["@Viewer please don't, that's rude."]);
  });

  it("says something in chat, not as a reply", async () => {
    const { item, ctx } = await said("you're awful");
    const action = say("Chat is in followers-only mode for a bit.");
    await action.run(firedOn(item), ctx);

    expect(twitch.sent).toEqual([{ broadcasterId: STREAMER.id, senderId: BOT.id, message: "Chat is in followers-only mode for a bit." }]);
    expect(action.describe(firedOn(item))).toBe('say "Chat is in followers-only mode for a bit."');
  });

  it("cuts messages and reasons to Twitch's 500 characters", async () => {
    const { item, ctx } = await said("you're awful");
    await say("😀".repeat(600)).run(firedOn(item), ctx);
    await timeout({ reason: "x".repeat(501) }).run(firedOn(item), ctx);

    expect(twitch.sent.map((sent) => sent.message)).toEqual([`${"😀".repeat(499)}…`]);
    expect(twitch.bans.map((each) => each.reason)).toEqual([`${"x".repeat(499)}…`]);
  });

  it("says why Twitch didn't send a message", async () => {
    const { item, ctx } = await said("you're awful");
    twitch.bans.push({ broadcasterId: STREAMER.id, moderatorId: STREAMER.id, userId: BOT.id, reason: "rude bot" });

    await expect(say("hello").run(firedOn(item), ctx)).rejects.toThrow("Twitch didn't send the message to #mychannel: You are banned from this channel.");
    expect(twitch.sent).toEqual([]);
  });
});

describe("twitch.clip", () => {
  it("clips the stream and logs where to edit the clip", async () => {
    const { item, ctx, reader } = await said("POGGERS");
    const action = clip();
    await action.run(firedOn(item, "hype"), ctx);

    expect(twitch.calls("/helix/clips")).toMatchObject([{ method: "POST", query: { broadcaster_id: STREAMER.id } }]);
    expect(twitch.clips).toHaveLength(1);
    expect(reader.infos).toContain(`twitch: clipped #mychannel: https://clips.twitch.tv/${twitch.clips[0]}/edit`);
    expect(action.describe(firedOn(item))).toBe("create a clip");
  });

  it("says when the channel isn't live", async () => {
    const { item, ctx } = await said("POGGERS");
    twitch.live(STREAMER, false);

    await expect(clip().run(firedOn(item), ctx)).rejects.toThrow("Can't clip #mychannel: it isn't live.");
    expect(twitch.clips).toEqual([]);
  });
});

describe("when an action can't run", () => {
  it("says which permission the account didn't allow", async () => {
    const { item, ctx } = await said("you're awful", {}, await reading("mychannel", BOT, ["user:read:chat"]));

    await expect(timeout().run(firedOn(item), ctx)).rejects.toThrow(
      "Twitch POST /moderation/bans failed: the account hasn't allowed moderator:manage:banned_users. Sign in again and allow it.",
    );
  });

  it("renews an expired token, saves it and carries on", async () => {
    const { item, ctx, reader } = await said("you're awful");
    twitch.expireTokens();
    await timeout().run(firedOn(item), ctx);

    expect(twitch.bans).toHaveLength(1);
    expect(reader.saved).toHaveLength(1);
  });

  it("only runs on items from twitch.chat()", async () => {
    await expect(
      timeout().run(firedOn(EXAMPLE), {
        // What an action gets from a source without a session, such as twitchChat().
        session: undefined as never,
        connection: undefined,
        source: twitchChat("mychannel"),
        log: silentLogger,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Twitch actions run on items from twitch.chat().");
  });
});

describe("in a monitor", () => {
  const hateful = noul("Is this chat message hateful?");
  // Only the message itself, not the recent messages sent with it as context.
  const jev = () => mockJev(({ state }) => ({ hateful: JSON.stringify((state as { message?: unknown }).message).includes("awful") ? 0.95 : 0.05 }));

  it("only says what it would do in dry-run, the default", async () => {
    const actions: Array<ActionEvent<TwitchChatItem>> = [];
    const mods = monitor({ source: chat("mychannel"), questions: { hateful }, client: jev(), log: silentLogger })
      .on("hateful", timeout())
      .on("action", (e) => void actions.push(e));
    await mods.start({ store: memoryStore(), connections: [connectionTo(twitch)] });
    twitch.chat("you're awful");
    await waitFor(() => actions.length === 1);
    await mods.stop();

    expect(actions.map((e) => [e.status, e.description])).toEqual([["dry-run", "timeout Viewer for 600s"]]);
    expect(actions[0]?.event.connection).toMatchObject({ id: connectionId("twitch", BOT.id), integration: "twitch", label: "jevbot" });
    expect(twitch.bans).toEqual([]);
  });

  it("deletes the message and times the chatter out when armed, and leaves moderators alone", async () => {
    twitch.mod(A_MOD);
    const actions: Array<ActionEvent<TwitchChatItem>> = [];
    const mods = monitor({ source: chat("mychannel"), questions: { hateful }, client: jev(), dryRun: false, log: silentLogger })
      .on("hateful", deleteMessage())
      .on("hateful", timeout())
      .on("action", (e) => void actions.push(e));
    await mods.start({ store: memoryStore(), connections: [connectionTo(twitch)] });
    const awful = twitch.chat("you're awful");
    twitch.chat("you're awful too", { from: A_MOD, badges: ["moderator"] });
    twitch.chat("hello everyone", { from: OTHER });
    await waitFor(() => actions.length === 4);
    await mods.idle();
    await mods.stop();

    expect(actions.map((e) => `${e.event.item.author.name}: ${e.status} ${e.description}${e.reason ? ` (${e.reason})` : ""}`).sort()).toEqual([
      "AMod: skipped delete the message from AMod (protected user)",
      "AMod: skipped timeout AMod for 600s (protected user)",
      "Viewer: done delete the message from Viewer",
      "Viewer: done timeout Viewer for 600s",
    ]);
    expect(twitch.deleted).toEqual([awful]);
    expect(twitch.bans).toEqual([{ broadcasterId: STREAMER.id, moderatorId: BOT.id, userId: VIEWER.id, duration: 600, reason: "jev-events: hateful (95%)" }]);
  });

  it("marks the account as needing a new sign-in when Twitch takes back access", async () => {
    const store = memoryStore();
    const errors: ErrorEvent[] = [];
    const mods = monitor({ source: chat("mychannel"), questions: { hateful }, client: jev(), log: silentLogger }).on("error", (e) => void errors.push(e));
    await mods.start({ store, connections: [connectionTo(twitch)] });
    twitch.revoke("authorization_revoked");
    await waitFor(() => errors.length === 1);
    await mods.stop();

    expect(await store.connections.get(connectionId("twitch", BOT.id))).toMatchObject({
      status: "needs-sign-in",
      problem: "jevbot took back the app's access on Twitch, so it can't read #mychannel's chat anymore (authorization_revoked).",
    });
    expect(errors).toMatchObject([{ phase: "source", fatal: true, needsSignIn: true }]);
    await waitFor(() => twitch.sockets === 0, 2_000, "chat to close");
  });

  it("marks it before connecting when its sign-in no longer works", async () => {
    const connection = connectionTo(twitch);
    twitch.revokeTokens();
    const store = memoryStore();
    const errors: ErrorEvent[] = [];
    const mods = monitor({ source: chat("mychannel"), questions: { hateful }, client: jev(), log: silentLogger }).on("error", (e) => void errors.push(e));
    await mods.start({ store, connections: [connection] });
    await mods.stop();

    expect(await store.connections.get(connection.id)).toMatchObject({ status: "needs-sign-in", problem: expect.stringMatching(/^Twitch signed this account out/) });
    expect(errors).toMatchObject([{ phase: "source", fatal: true, needsSignIn: true }]);
    expect(twitch.connections).toEqual([]);
  });

  it("saves renewed tokens to the store", async () => {
    const store = memoryStore();
    const connection = connectionTo(twitch, BOT, { expiresIn: 30 });
    const mods = monitor({ source: chat("mychannel"), questions: { hateful }, client: jev(), log: silentLogger });
    await mods.start({ store, connections: [connection] });
    await mods.stop();

    const saved = await store.connections.get(connection.id);
    expect(saved?.credentials.refreshToken).not.toBe(connection.credentials.refreshToken);
    expect(twitch.spent.has(String(connection.credentials.refreshToken))).toBe(true);
    expect(saved).toMatchObject({ status: "active" });
  });

  it("finishes a run() once it's listening, since chat has no history", async () => {
    const stats = await monitor({ source: chat("mychannel"), questions: { hateful }, client: jev(), log: silentLogger }).run({
      store: memoryStore(),
      connections: [connectionTo(twitch)],
    });

    expect(stats).toMatchObject({ judged: 0, errors: 0 });
    await waitFor(() => twitch.sockets === 0, 2_000, "chat to close");
    expect(twitch.connections).toEqual(["open 1", "close 1"]);
  });

  it("won't arm native actions on chat read without signing in", async () => {
    const mods = monitor({
      // Nothing listens there: the monitor refuses before connecting.
      source: twitchChat("mychannel", { endpoint: "ws://127.0.0.1:9" }),
      questions: { hateful },
      client: jev(),
      dryRun: false,
      log: silentLogger,
    }).on("hateful", timeout());

    await expect(mods.start({ store: memoryStore() })).rejects.toThrow(
      "twitch:chat:mychannel can't run native actions because it isn't authenticated. Read it as a signed-in account, or keep dryRun: true to see what would happen.",
    );
  });
});

