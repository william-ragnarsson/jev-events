import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { messages, withTokens, type MessagesOptions, type SlackMessageItem } from "@jev-events/slack";

import { ANN, ANN_DM, APP_TOKEN, BOB, BOT, BOT_TOKEN, ERIN, fakeSlack, GENERAL, GUEST, RANDOM, type FakeSlack } from "./fake-slack.js";
import { startSource, waitFor, type Started } from "./helpers.js";

let slack: FakeSlack;
let running: Array<Started<SlackMessageItem>> = [];

beforeEach(async () => {
  slack = await fakeSlack();
});

afterEach(async () => {
  for (const run of running) run.stop();
  running = [];
  await slack.close();
});

const auth = () => withTokens({ token: BOT_TOKEN, appToken: APP_TOKEN });

function start(options: Partial<MessagesOptions> = {}) {
  const source = messages({ auth: auth(), ...options });
  const run = startSource(source);
  running.push(run);
  return { source, ...run };
}

/** Start watching and wait until it's connected. */
async function watch(options: Partial<MessagesOptions> = {}) {
  const started = start(options);
  await started.started;
  return started;
}

const texts = (items: SlackMessageItem[]) => items.map((item) => item.text);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("slack.messages", () => {
  it("emits each new message, saying who wrote it and where, with names for mentions", async () => {
    const { source, items } = await watch();
    const sent = slack.post({ channel: GENERAL, text: `<@${BOB}> is prod down? See <#${RANDOM}>` });
    await waitFor(() => items.length === 1);

    expect(items[0]).toMatchObject({
      id: `${GENERAL}:${sent.ts}`,
      text: "@Bob is prod down? See #random",
      author: { id: ANN, name: "Ann Smith", roles: ["owner"], guest: false, external: false, bot: false },
      channel: { id: GENERAL, name: "general", kind: "channel" },
      facts: { channel: "#general" },
      mentions: [BOB],
      inThread: false,
      permalink: `https://acme.slack.com/archives/${GENERAL}/p${sent.ts.replace(".", "")}`,
    });
    expect(source.id).toBe("slack:messages");
    expect(source.session).toMatchObject({ team: "Acme", teamId: "T0ACME", user: "jev_events", userId: BOT.userId, url: "https://acme.slack.com/" });
    expect(source.session?.conversations.map((conversation) => conversation.id)).toEqual([GENERAL, RANDOM, ANN_DM]);
  });

  it("knows direct messages and replies in threads", async () => {
    const { items } = await watch();
    slack.post({ channel: ANN_DM, text: "can you check my PR?" });
    const parent = slack.post({ channel: GENERAL, text: "Deploy at 5", live: false });
    slack.post({ channel: GENERAL, user: BOB, text: "can we wait?", thread_ts: parent.ts });
    await waitFor(() => items.length === 2);

    expect(items[0]).toMatchObject({ channel: { id: ANN_DM, kind: "dm" }, facts: { channel: "DM" }, inThread: false });
    expect(items[1]).toMatchObject({ author: { name: "Bob" }, inThread: true, threadTs: parent.ts, facts: { channel: "#general", inThread: true } });
  });

  it("flags guests and people from other companies", async () => {
    const { items } = await watch();
    slack.post({ channel: GENERAL, user: GUEST, text: "hi from a guest" });
    slack.post({ channel: GENERAL, user: ERIN, user_team: "T0PARTNER", text: "hi from Partner Co" });
    await waitFor(() => items.length === 2);

    expect(items.map((item) => item.facts)).toEqual([
      { channel: "#general", fromGuest: true },
      { channel: "#general", fromOtherCompany: true },
    ]);
  });

  it("starts with the latest messages, oldest first, then new ones", async () => {
    for (let n = 1; n <= 7; n++) slack.post({ channel: n % 2 ? GENERAL : RANDOM, text: `old ${n}`, live: false });
    const { items } = await watch({ backfill: 5 });
    await waitFor(() => items.length === 5);
    slack.post({ channel: RANDOM, text: "new" });
    await waitFor(() => items.length === 6);

    expect(texts(items)).toEqual(["old 3", "old 4", "old 5", "old 6", "old 7", "new"]);
  });

  it("holds new messages back while the latest load, so they come out in order", async () => {
    const first = slack.post({ channel: GENERAL, text: "old 1", live: false });
    slack.post({ channel: GENERAL, text: "old 2", live: false });
    slack.delay("conversations.history", 150);
    const { items } = await watch({ backfill: 5 });
    // A reply in a thread, which only arrives live, since the channel's history leaves replies out.
    slack.post({ channel: GENERAL, user: BOB, text: "new reply", thread_ts: first.ts });
    await waitFor(() => items.length === 3);

    expect(texts(items)).toEqual(["old 1", "old 2", "new reply"]);
  });

  it("emits each message once, when Slack sends it again and when the latest overlap new ones", async () => {
    slack.delay("conversations.history", 100);
    const { items } = await watch({ backfill: 5 });
    // Posted while the latest load, so it's in the history and arrives live too.
    slack.post({ channel: GENERAL, text: "both ways" });
    await waitFor(() => items.length === 1);
    slack.redeliver();
    slack.post({ channel: GENERAL, text: "next" });
    await waitFor(() => items.length === 2 && slack.acks.length === 3);
    await pause(30);

    expect(texts(items)).toEqual(["both ways", "next"]);
  });

  it("skips joins, edits, bots, its own posts and empty messages, and keeps files", async () => {
    const { items } = await watch();
    slack.post({ channel: GENERAL, user: BOB, subtype: "channel_join", text: `<@${BOB}> has joined the channel` });
    slack.send({
      type: "message",
      subtype: "message_changed",
      hidden: true,
      channel: GENERAL,
      channel_type: "channel",
      ts: "1760000000.000200",
      message: { type: "message", user: ANN, text: "edited", ts: "1760000000.000100" },
    });
    slack.post({ channel: GENERAL, user: undefined, bot_id: "B0DEPLOY", subtype: "bot_message", username: "Deploys", text: "Deployed v2" });
    slack.post({ channel: GENERAL, user: BOT.userId, bot_id: BOT.botId, text: "I'm the app" });
    slack.post({ channel: GENERAL, text: "   " });
    slack.send({ type: "reaction_added", user: ANN, reaction: "eyes", item: { type: "message", channel: GENERAL, ts: "1760000000.000100" } });
    slack.post({ channel: GENERAL, text: "", files: [{ name: "q3.pdf", mimetype: "application/pdf" }] });
    slack.post({ channel: GENERAL, text: "last" });
    await waitFor(() => items.length === 2);
    await pause(30);

    expect(texts(items)).toEqual(["[file: q3.pdf]", "last"]);
    expect(items[0]?.files).toEqual([{ name: "q3.pdf", type: "application/pdf" }]);
  });

  it("judges bots too with includeBots, but never its own posts", async () => {
    const { items } = await watch({ includeBots: true });
    slack.post({ channel: GENERAL, user: undefined, bot_id: "B0DEPLOY", subtype: "bot_message", username: "Deploys", text: "Deploy failed" });
    slack.post({ channel: GENERAL, user: BOT.userId, bot_id: BOT.botId, text: "I'm the app" });
    slack.post({ channel: GENERAL, text: "last" });
    await waitFor(() => items.length === 2);
    await pause(30);

    expect(texts(items)).toEqual(["Deploy failed", "last"]);
    expect(items[0]).toMatchObject({ author: { id: "B0DEPLOY", name: "Deploys", bot: true }, facts: { fromBot: true } });
  });

  it("watches only the channels you name", async () => {
    slack.post({ channel: RANDOM, text: "old random", live: false });
    slack.post({ channel: GENERAL, text: "old general", live: false });
    const { source, items } = await watch({ channels: ["#general"], backfill: 5 });
    slack.post({ channel: RANDOM, text: "new random" });
    slack.post({ channel: GENERAL, text: "new general" });
    await waitFor(() => items.length === 2);
    await pause(30);

    expect(texts(items)).toEqual(["old general", "new general"]);
    expect(source.id).toBe("slack:#general");
    expect(source.session?.conversations).toEqual([{ id: GENERAL, name: "general", kind: "channel", member: true }]);
    expect(slack.calls("conversations.history").map((call) => call.params.channel)).toEqual([GENERAL]);
    expect(messages({ auth: auth(), channels: ["general", " #random "] }).id).toBe("slack:#general,#random");
  });

  it("says how to add the app to a channel it isn't in yet", async () => {
    const { started } = start({ channels: ["off-topic"] });

    await expect(started).rejects.toThrow("The app (@jev_events) isn't in #off-topic yet. In Slack, open #off-topic and type: /invite @jev_events");
    expect(slack.sockets).toBe(0);
  });

  it("says when there's no such channel", async () => {
    await expect(start({ channels: ["#nope"] }).started).rejects.toThrow(
      "There's no #nope channel that the app can see. If it's private, invite the app to it first.",
    );
  });

  it.each([
    [
      "no app-level token or signing secret",
      () => ({ auth: withTokens({ token: BOT_TOKEN }) }),
      "Slack needs a way to deliver new messages: an app-level token (xapp-…) for Socket Mode, or a signing secret for the Events API. npx jev-events auth slack sets up Socket Mode.",
    ],
    [
      "Socket Mode without an app-level token",
      () => ({ auth: withTokens({ token: BOT_TOKEN, signingSecret: "secret" }), delivery: "socket" as const }),
      "Socket Mode needs the app-level token (xapp-…): slack.auth.withTokens({ token, appToken }). Make one under Basic Information → App-Level Tokens, with the connections:write scope.",
    ],
    [
      "the Events API without a signing secret",
      () => ({ auth: auth(), delivery: "events" as const }),
      "The Events API needs the app's signing secret, from Basic Information → App Credentials: slack.auth.withTokens({ token, signingSecret }).",
    ],
  ])("says what's missing, given %s", async (_, options, message) => {
    await expect(start(options()).started).rejects.toThrow(message);
    expect(slack.calls()).toEqual([]);
  });

  it("fails to start when Slack refuses the token", async () => {
    slack.revoke();

    await expect(start().started).rejects.toThrow("Slack signed you out (token_revoked): the token was revoked or isn't valid. Connect again: npx jev-events auth slack");
  });

  it("stops when Slack signs the app out", async () => {
    const { items, errors, signal } = await watch();
    slack.revoke();
    slack.post({ channel: GENERAL, text: "anyone?" });
    await waitFor(() => errors.length === 1);

    expect(errors[0]?.fatal).toBe(true);
    expect(String(errors[0]?.error)).toContain("Slack signed you out (token_revoked)");
    expect(signal.aborted).toBe(true);
    expect(items).toEqual([]);
  });

  it("stops when Socket Mode is turned off", async () => {
    const { errors } = await watch();
    slack.disconnect("link_disabled");
    await waitFor(() => errors.length === 1);

    expect(errors[0]?.fatal).toBe(true);
    expect((errors[0]?.error as Error).message).toBe("Socket Mode is off for this Slack app. Turn it on under Settings → Socket Mode, then try again.");
  });

  it("warns about a conversation whose history it can't read, and goes on", async () => {
    slack.removeScope("im:history");
    slack.post({ channel: ANN_DM, text: "old dm", live: false });
    slack.post({ channel: GENERAL, text: "old general", live: false });
    const { items, warnings, errors } = await watch({ backfill: 5 });
    await waitFor(() => items.length === 1);

    expect(texts(items)).toEqual(["old general"]);
    expect(warnings).toEqual([
      "Couldn't read the latest messages in DM: Slack conversations.history failed: the app lacks the im:history scope. Add it under OAuth & Permissions → Scopes, reinstall the app, then run: npx jev-events auth slack",
    ]);
    expect(errors).toEqual([]);
  });

  it("stops when Slack signs the app out while the latest load", async () => {
    slack.fail("conversations.history", "token_revoked", { times: 3 });
    const { errors, signal } = await watch({ backfill: 5 });
    await waitFor(() => errors.length === 1);

    expect(errors[0]?.fatal).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it("stops cleanly", async () => {
    const { items, stop } = await watch();
    stop();
    await waitFor(() => slack.sockets === 0);
    slack.post({ channel: GENERAL, text: "after stop" });
    await pause(50);

    expect(items).toEqual([]);
  });
});
