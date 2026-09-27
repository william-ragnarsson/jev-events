import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { connectionId, memoryStore, monitor, noul, silentLogger, type ActionEvent, type ErrorEvent } from "jev-events";
import { mockJev } from "jev-events/testing";
import { messages, post, react, reply, type SlackMessageItem, type SlackSession } from "@jev-events/slack";

import { ANN, ANN_DM, BOB, BOT, fakeSlack, GENERAL, TEAM, type FakeMessage, type FakeSlack } from "./fake-slack.js";
import { connectionTo, firedOn, stopAll, streamer, waitFor, type Streamer } from "./helpers.js";

let slack: FakeSlack;
let run: Streamer<SlackMessageItem, SlackSession> | undefined;

beforeEach(async () => {
  slack = await fakeSlack();
  run = undefined;
});

afterEach(async () => {
  stopAll();
  await slack.close();
});

/** Someone says something in Slack; returns the item the source emits for it, and what an action gets. */
async function said(message: FakeMessage) {
  if (!run) {
    run = streamer(messages(), { connection: connectionTo(slack) });
    await run.start();
  }
  const { items } = run;
  const before = items.length;
  slack.post(message);
  await waitFor(() => items.length > before, 2_000, "the message");
  const item = items[before]!;
  return { item, ctx: await run.actionContext() };
}

const postedParams = () => slack.calls("chat.postMessage").map((call) => call.params);

describe("slack.reply", () => {
  it("replies in the message's thread", async () => {
    const { item, ctx } = await said({ channel: GENERAL, text: "Is prod down?" });
    const action = reply("Looking into it.");
    await action.run(firedOn(item), ctx);

    expect(postedParams()).toEqual([{ channel: GENERAL, thread_ts: item.ts, text: "Looking into it." }]);
    expect(slack.posted).toMatchObject([{ user: BOT.userId, text: "Looking into it.", thread_ts: item.ts }]);
    expect(action.describe(firedOn(item))).toBe('reply in the thread to Ann Smith: "Looking into it."');
  });

  it("replies in the same thread to a reply", async () => {
    const parent = slack.post({ channel: GENERAL, text: "Deploy at 5", live: false });
    const { item, ctx } = await said({ channel: GENERAL, user: BOB, text: "can we wait?", thread_ts: parent.ts });
    await reply("Sure.").run(firedOn(item), ctx);

    expect(postedParams()).toEqual([{ channel: GENERAL, thread_ts: parent.ts, text: "Sure." }]);
  });

  it("answers right in the conversation in a direct message", async () => {
    const { item, ctx } = await said({ channel: ANN_DM, text: "can you check my PR?" });
    const action = reply("On it.");
    await action.run(firedOn(item), ctx);

    expect(postedParams()).toEqual([{ channel: ANN_DM, text: "On it." }]);
    expect(action.describe(firedOn(item))).toBe('reply to Ann Smith: "On it."');
  });

  it("also posts the reply in the channel with broadcast", async () => {
    const { item, ctx } = await said({ channel: GENERAL, text: "Is prod down?" });
    await reply("Yes, fixing it.", { broadcast: true }).run(firedOn(item), ctx);

    expect(postedParams()).toEqual([{ channel: GENERAL, thread_ts: item.ts, reply_broadcast: "true", text: "Yes, fixing it." }]);
    expect(slack.posted).toMatchObject([{ subtype: "thread_broadcast", thread_ts: item.ts }]);
  });

  it("makes the text from what fired", async () => {
    const { item, ctx } = await said({ channel: GENERAL, text: "Is prod down?" });
    await reply((event) => `<@${event.item.author.id}> this looks ${event.trigger.event}`).run(firedOn(item, "urgent"), ctx);

    expect(slack.posted.map((message) => message.text)).toEqual([`<@${ANN}> this looks urgent`]);
  });

  it("says how to add the app back when it was removed from the channel", async () => {
    const { item, ctx } = await said({ channel: GENERAL, text: "Is prod down?" });
    slack.leave(GENERAL);

    await expect(reply("On it.").run(firedOn(item), ctx)).rejects.toThrow(
      "The app (@jev_events) isn't in #general. In Slack, open #general and type: /invite @jev_events",
    );
  });
});

describe("slack.react", () => {
  it("adds the emoji once, however it's written", async () => {
    const { item, ctx } = await said({ channel: GENERAL, text: "Is prod down?" });
    await react(":eyes:").run(firedOn(item), ctx);
    await react("eyes").run(firedOn(item), ctx);
    await react("white_check_mark").run(firedOn(item), ctx);

    expect(slack.reactions(GENERAL, item.ts)).toEqual(["eyes", "white_check_mark"]);
    expect(slack.calls("reactions.add").map((call) => call.params.name)).toEqual(["eyes", "eyes", "white_check_mark"]);
    expect(react(":eyes:").describe(firedOn(item))).toBe("react with :eyes: to Ann Smith's message");
  });

  it("says which scope the app lacks", async () => {
    const { item, ctx } = await said({ channel: GENERAL, text: "Is prod down?" });
    slack.removeScope("reactions:write");

    await expect(react("eyes").run(firedOn(item), ctx)).rejects.toThrow(
      "Slack reactions.add failed: the app lacks the reactions:write scope. Add it under OAuth & Permissions → Scopes, then reinstall the app to the workspace.",
    );
  });
});

describe("slack.post", () => {
  beforeEach(() => slack.addConversation({ id: "C0ALERTS", name: "alerts" }));

  it("posts an alert with what fired, who wrote what and where, and a link", async () => {
    const { item, ctx } = await said({ channel: GENERAL, text: "is 2 &lt; 3 &amp;&amp; prod down?" });
    const action = post("#alerts");
    await action.run(firedOn(item, "urgent"), ctx);
    const lookups = slack.calls("conversations.list").length;
    await action.run(firedOn(item, "urgent"), ctx);

    const alert = `*urgent* · Ann Smith in #general: “is 2 &lt; 3 &amp;&amp; prod down?”\n<${item.permalink}|Open in Slack>`;
    expect(item.text).toBe("is 2 < 3 && prod down?");
    expect(postedParams()).toEqual([
      { channel: "C0ALERTS", text: alert },
      { channel: "C0ALERTS", text: alert },
    ]);
    expect(slack.calls("conversations.list")).toHaveLength(lookups);
    expect(action.describe(firedOn(item, "urgent"))).toMatch(/^post in #alerts: "\*urgent\* · Ann Smith in #general: “is 2 &lt; 3/);
  });

  it("posts your text instead", async () => {
    const { item, ctx } = await said({ channel: GENERAL, text: "Is prod down?" });
    await post("alerts", (event) => `${event.item.author.name} needs help`).run(firedOn(item), ctx);

    expect(postedParams()).toEqual([{ channel: "C0ALERTS", text: "Ann Smith needs help" }]);
  });

  it("says when there's no such channel, and finds it once there is", async () => {
    const { item, ctx } = await said({ channel: GENERAL, text: "Is prod down?" });
    const action = post("#incidents");

    await expect(action.run(firedOn(item), ctx)).rejects.toThrow("There's no #incidents channel that the app can see. If it's private, invite the app to it first.");
    slack.addConversation({ id: "C0INCIDENTS", name: "incidents" });
    await action.run(firedOn(item), ctx);
    expect(postedParams()).toMatchObject([{ channel: "C0INCIDENTS" }]);
  });

  it("says how to add the app to the channel", async () => {
    const { item, ctx } = await said({ channel: GENERAL, text: "Is prod down?" });

    await expect(post("off-topic").run(firedOn(item), ctx)).rejects.toThrow(
      "The app (@jev_events) isn't in #off-topic. In Slack, open #off-topic and type: /invite @jev_events",
    );
  });
});

it("runs only on items from slack.messages()", async () => {
  const { item, ctx } = await said({ channel: GENERAL, text: "Is prod down?" });

  await expect(reply("On it.").run(firedOn(item), { ...ctx, session: undefined as never })).rejects.toThrow(
    "Slack actions run on items from slack.messages().",
  );
});

describe("in a monitor", () => {
  const needsAnswer = noul("Does this message need an answer from the team?");
  const jev = () => mockJev(({ state }) => ({ needsAnswer: JSON.stringify(state).includes("prod down") ? 0.95 : 0.05 }));

  it("only says what it would do in dry-run, the default", async () => {
    const actions: Array<ActionEvent<SlackMessageItem>> = [];
    const team = monitor({ source: messages(), questions: { needsAnswer }, client: jev(), log: silentLogger })
      .on("needsAnswer", react("eyes"))
      .on("action", (e) => void actions.push(e));
    await team.start({ store: memoryStore(), connections: [connectionTo(slack)] });
    slack.post({ channel: GENERAL, text: "Is prod down?" });
    await waitFor(() => actions.length === 1);
    await team.stop();

    expect(actions.map((e) => [e.status, e.description])).toEqual([["dry-run", "react with :eyes: to Ann Smith's message"]]);
    expect(actions[0]?.event.connection).toMatchObject({ id: connectionId("slack", TEAM.id), integration: "slack", label: "Acme" });
    expect(slack.calls("reactions.add")).toEqual([]);
  });

  it("reacts and alerts #alerts when armed, and leaves other messages alone", async () => {
    slack.addConversation({ id: "C0ALERTS", name: "alerts" });
    const actions: Array<ActionEvent<SlackMessageItem>> = [];
    const team = monitor({ source: messages(), questions: { needsAnswer }, client: jev(), dryRun: false, log: silentLogger })
      .on("needsAnswer", react("eyes"))
      .on("needsAnswer", post("#alerts"))
      .on("action", (e) => void actions.push(e));
    await team.start({ store: memoryStore(), connections: [connectionTo(slack)] });
    const question = slack.post({ channel: GENERAL, text: "Is prod down?" });
    const other = slack.post({ channel: GENERAL, user: BOB, text: "Deploy done." });
    await waitFor(() => actions.length === 2);
    await team.idle();
    await team.stop();

    expect(actions.map((e) => e.status)).toEqual(["done", "done"]);
    expect(slack.reactions(GENERAL, question.ts)).toEqual(["eyes"]);
    expect(slack.reactions(GENERAL, other.ts)).toEqual([]);
    expect(slack.posted).toMatchObject([{ channel: "C0ALERTS", text: expect.stringContaining("*needsAnswer* · Ann Smith in #general: “Is prod down?”") }]);
  });

  it("reads the latest messages once with run(), then finishes", async () => {
    slack.post({ channel: GENERAL, text: "Is prod down?", live: false });
    slack.post({ channel: GENERAL, user: BOB, text: "Deploy done.", live: false });
    const judged: SlackMessageItem[] = [];

    const stats = await monitor({ source: messages({ backfill: 5 }), questions: { needsAnswer }, client: jev(), log: silentLogger })
      .on("judged", (e) => void judged.push(e.item))
      .run({ store: memoryStore(), connections: [connectionTo(slack)] });

    expect(judged.map((item) => item.text)).toEqual(["Is prod down?", "Deploy done."]);
    expect(stats).toMatchObject({ judged: 2, errors: 0 });
  });

  it("marks the workspace as needing a new sign-in when Slack signed it out", async () => {
    slack.revoke();
    const store = memoryStore();
    const errors: ErrorEvent[] = [];
    const team = monitor({ source: messages(), questions: { needsAnswer }, client: jev(), log: silentLogger }).on("error", (e) => void errors.push(e));
    await team.start({ store, connections: [connectionTo(slack)] });
    await team.stop();

    const saved = await store.connections.get(connectionId("slack", TEAM.id));
    expect(saved).toMatchObject({
      status: "needs-sign-in",
      problem: "Slack signed this workspace out (token_revoked): the token was revoked or isn't valid.",
    });
    expect(errors).toMatchObject([{ phase: "source", fatal: true, needsSignIn: true }]);
  });
});
