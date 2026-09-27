import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { app, fromEnv, messages, type MessagesOptions, type SlackMessageItem } from "@jev-events/slack";

import { ANN, ANN_DM, BOB, BOT, ERIN, fakeSlack, GENERAL, GUEST, RANDOM, TEAM, type FakeSlack } from "./fake-slack.js";
import { connectionTo, pause, stopAll, streamer, waitFor } from "./helpers.js";

let slack: FakeSlack;

beforeEach(async () => {
  slack = await fakeSlack();
});

afterEach(async () => {
  stopAll();
  vi.unstubAllEnvs();
  await slack.close();
});

/** The source running for the fake workspace, not yet started. */
function reading(options: MessagesOptions = {}, connection = connectionTo(slack)) {
  const source = messages(options);
  // Not spread: `ended` is a getter.
  return Object.assign(streamer(source, { connection }), { source });
}

/** Start watching and wait until it's connected. */
async function watch(options: MessagesOptions = {}) {
  const run = reading(options);
  await run.start();
  return run;
}

const texts = (items: SlackMessageItem[]) => items.map((item) => item.text);

describe("slack.messages", () => {
  it("emits each new message, saying who wrote it and where, with names for mentions", async () => {
    const { source, items, session } = await watch();
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
    expect(source.integration).toBe("slack");
    const opened = await session();
    expect(opened).toMatchObject({ team: "Acme", teamId: TEAM.id, user: "jev_events", userId: BOT.userId, botId: BOT.botId, url: TEAM.url });
    expect(opened.conversations?.map((conversation) => conversation.id)).toEqual([GENERAL, RANDOM, ANN_DM]);
    // Who the app is was saved with the connection, so starting doesn't ask Slack again.
    expect(slack.calls("auth.test")).toEqual([]);
    // The app-level token only opens Socket Mode; everything else uses the bot token.
    expect(slack.calls().filter((call) => call.method !== "apps.connections.open").every((call) => call.token === "xoxb-1-fake-bot-token")).toBe(true);
  });

  it("asks Slack who the app is when the connection doesn't say", async () => {
    const { token, appToken } = slack.connection().credentials;
    vi.stubEnv("SLACK_BOT_TOKEN", String(token));
    vi.stubEnv("SLACK_APP_TOKEN", String(appToken));
    const run = reading({}, fromEnv());
    await run.start();
    slack.post({ channel: GENERAL, text: "hello" });
    await waitFor(() => run.items.length === 1);

    expect(await run.session()).toMatchObject({ team: "Acme", teamId: TEAM.id, user: "jev_events" });
    expect(slack.calls("auth.test")).toHaveLength(1);
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
    const run = await watch({ backfill: 5 });
    await waitFor(() => run.items.length === 5);
    slack.post({ channel: RANDOM, text: "new" });
    await waitFor(() => run.items.length === 6);

    expect(texts(run.items)).toEqual(["old 3", "old 4", "old 5", "old 6", "old 7", "new"]);
    // Ended, so monitor.run() can finish; the socket stays open for monitor.start().
    expect(run.ended).toBe(true);
  });

  it("ends at once without a backfill", async () => {
    const run = await watch();

    expect(run.ended).toBe(true);
    expect(slack.sockets).toBe(1);
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
    const { source, items, session } = await watch({ channels: ["#general"], backfill: 5 });
    slack.post({ channel: RANDOM, text: "new random" });
    slack.post({ channel: GENERAL, text: "new general" });
    await waitFor(() => items.length === 2);
    await pause(30);

    expect(texts(items)).toEqual(["old general", "new general"]);
    expect(source.id).toBe("slack:#general");
    expect((await session()).conversations).toEqual([{ id: GENERAL, name: "general", kind: "channel", member: true }]);
    expect(slack.calls("conversations.history").map((call) => call.params.channel)).toEqual([GENERAL]);
    expect(messages({ channels: ["general", " #random "] }).id).toBe("slack:#general,#random");
  });

  it("says how to add the app to a channel it isn't in yet", async () => {
    await expect(reading({ channels: ["off-topic"] }).start()).rejects.toThrow(
      "The app (@jev_events) isn't in #off-topic yet. In Slack, open #off-topic and type: /invite @jev_events",
    );
    expect(slack.sockets).toBe(0);
  });

  it("says when there's no such channel", async () => {
    await expect(reading({ channels: ["#nope"] }).start()).rejects.toThrow(
      "There's no #nope channel that the app can see. If it's private, invite the app to it first.",
    );
  });

  it("says a connection is needed when there is none", async () => {
    const source = messages();
    await expect(streamer(source).start()).rejects.toThrow(
      "slack:messages reads connected Slack workspaces, so it needs a connection. Connect one with npx jev-events auth slack, or pass connections to start().",
    );
    expect(slack.calls()).toEqual([]);
  });

  it("leaves new messages to the Events API when there's no app-level token", async () => {
    const run = reading({ backfill: 5 }, connectionTo(slack, { appToken: false }));
    slack.post({ channel: GENERAL, text: "old", live: false });
    await run.start();
    await waitFor(() => run.ended);

    expect(texts(run.items)).toEqual(["old"]);
    expect(run.infos).toEqual(["slack: Acme has no app-level token, so its new messages come through the Events API at /webhook/slack."]);
    expect(slack.calls("apps.connections.open")).toEqual([]);
  });

  it("takes the app-level token from slack.app() or SLACK_APP_TOKEN when the connection has none", async () => {
    const connection = connectionTo(slack, { appToken: false });
    const source = messages();
    const viaApp = streamer(source, { connection, app: app({ appToken: "xapp-1-fake-app-token" }) });
    await viaApp.start();
    slack.post({ channel: GENERAL, text: "one" });
    await waitFor(() => viaApp.items.length === 1);
    viaApp.stop();
    await waitFor(() => slack.sockets === 0);

    vi.stubEnv("SLACK_APP_TOKEN", "xapp-1-fake-app-token");
    const viaEnv = streamer(source, { connection });
    await viaEnv.start();
    slack.post({ channel: GENERAL, text: "two" });
    await waitFor(() => viaEnv.items.length === 1);

    expect(texts([...viaApp.items, ...viaEnv.items])).toEqual(["one", "two"]);
    expect(slack.connections).toEqual(["open 1", "close 1", "open 2"]);
  });

  it("shares one Socket Mode connection between everything using the same app", async () => {
    const needsAnswer = await watch();
    const everything = await watch({ includeBots: true });
    slack.post({ channel: GENERAL, text: "is prod down?" });
    await waitFor(() => needsAnswer.items.length === 1 && everything.items.length === 1);

    expect(slack.connections).toEqual(["open 1"]);
    needsAnswer.stop();
    slack.post({ channel: GENERAL, text: "hello?" });
    await waitFor(() => everything.items.length === 2);
    expect(slack.sockets).toBe(1);
    everything.stop();
    await waitFor(() => slack.sockets === 0);
    expect(needsAnswer.items).toHaveLength(1);
  });

  it("hands events only to the workspace they're from", async () => {
    const { items, warnings } = await watch();
    slack.send({ type: "message", channel: "C0ELSEWHERE", channel_type: "channel", user: "U0SOMEONE", text: "not for Acme", ts: "1760000000.000100" }, { team: "T0OTHER" });
    slack.post({ channel: GENERAL, text: "for Acme" });
    await waitFor(() => items.length === 1);
    await pause(30);

    expect(texts(items)).toEqual(["for Acme"]);
    expect(warnings).toEqual(["slack: events are coming in from workspace T0OTHER, which no monitor here reads. Connect it, or leave them be."]);
  });

  it("fails to start, needing a new sign-in, when Slack refuses the token", async () => {
    slack.revoke();

    const error = await reading().start().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "Slack signed this workspace out (token_revoked): the token was revoked or isn't valid.", needsSignIn: true });
  });

  it("stops, needing a new sign-in, when Slack signs the app out", async () => {
    const { items, errors, signal } = await watch();
    slack.revoke();
    slack.post({ channel: GENERAL, text: "anyone?" });
    await waitFor(() => errors.length === 1);

    expect(errors[0]?.fatal).toBe(true);
    expect(errors[0]?.error).toMatchObject({ message: "Slack signed this workspace out (token_revoked): the token was revoked or isn't valid.", needsSignIn: true });
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
      "Couldn't read the latest messages in DM: Slack conversations.history failed: the app lacks the im:history scope. Add it under OAuth & Permissions → Scopes, then reinstall the app to the workspace.",
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
