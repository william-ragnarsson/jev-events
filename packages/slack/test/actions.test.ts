import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listen, noul, silentLogger, type ActionEvent, type Source } from "jev-events";
import { mockJev } from "jev-events/testing";
import { messages, post, react, reply, withTokens, type SlackMessageItem, type SlackMessagesSource } from "@jev-events/slack";

import { ANN, ANN_DM, APP_TOKEN, BOB, BOT, BOT_TOKEN, fakeSlack, GENERAL, type FakeMessage, type FakeSlack } from "./fake-slack.js";
import { firedOn, startSource, waitFor, type Started } from "./helpers.js";

let slack: FakeSlack;
let source: SlackMessagesSource;
let run: Started<SlackMessageItem> | undefined;

beforeEach(async () => {
  slack = await fakeSlack();
  source = messages({ auth: withTokens({ token: BOT_TOKEN, appToken: APP_TOKEN }) });
  run = undefined;
});

afterEach(async () => {
  run?.stop();
  await slack.close();
});

/** Someone says something in Slack; returns the item the source emits for it. */
async function said(message: FakeMessage): Promise<SlackMessageItem> {
  run ??= startSource(source);
  const { items, started } = run;
  await started;
  const before = items.length;
  slack.post(message);
  await waitFor(() => items.length > before, 2_000, "the message");
  return items[before]!;
}

const postedParams = () => slack.calls("chat.postMessage").map((call) => call.params);

describe("slack.reply", () => {
  it("replies in the message's thread", async () => {
    const item = await said({ channel: GENERAL, text: "Is prod down?" });
    const action = reply("Looking into it.");
    await action.run(firedOn(item), source);

    expect(postedParams()).toEqual([{ channel: GENERAL, thread_ts: item.ts, text: "Looking into it." }]);
    expect(slack.posted).toMatchObject([{ user: BOT.userId, text: "Looking into it.", thread_ts: item.ts }]);
    expect(action.describe(firedOn(item))).toBe('reply in the thread to Ann Smith: "Looking into it."');
  });

  it("replies in the same thread to a reply", async () => {
    const parent = slack.post({ channel: GENERAL, text: "Deploy at 5", live: false });
    const item = await said({ channel: GENERAL, user: BOB, text: "can we wait?", thread_ts: parent.ts });
    await reply("Sure.").run(firedOn(item), source);

    expect(postedParams()).toEqual([{ channel: GENERAL, thread_ts: parent.ts, text: "Sure." }]);
  });

  it("answers right in the conversation in a direct message", async () => {
    const item = await said({ channel: ANN_DM, text: "can you check my PR?" });
    const action = reply("On it.");
    await action.run(firedOn(item), source);

    expect(postedParams()).toEqual([{ channel: ANN_DM, text: "On it." }]);
    expect(action.describe(firedOn(item))).toBe('reply to Ann Smith: "On it."');
  });

  it("also posts the reply in the channel with broadcast", async () => {
    const item = await said({ channel: GENERAL, text: "Is prod down?" });
    await reply("Yes, fixing it.", { broadcast: true }).run(firedOn(item), source);

    expect(postedParams()).toEqual([{ channel: GENERAL, thread_ts: item.ts, reply_broadcast: "true", text: "Yes, fixing it." }]);
    expect(slack.posted).toMatchObject([{ subtype: "thread_broadcast", thread_ts: item.ts }]);
  });

  it("makes the text from what fired", async () => {
    const item = await said({ channel: GENERAL, text: "Is prod down?" });
    await reply((event) => `<@${event.item.author.id}> this looks ${event.trigger.event}`).run(firedOn(item, "urgent"), source);

    expect(slack.posted.map((message) => message.text)).toEqual([`<@${ANN}> this looks urgent`]);
  });

  it("says how to add the app back when it was removed from the channel", async () => {
    const item = await said({ channel: GENERAL, text: "Is prod down?" });
    slack.leave(GENERAL);

    await expect(reply("On it.").run(firedOn(item), source)).rejects.toThrow(
      "The app (@jev_events) isn't in #general. In Slack, open #general and type: /invite @jev_events",
    );
  });
});

describe("slack.react", () => {
  it("adds the emoji once, however it's written", async () => {
    const item = await said({ channel: GENERAL, text: "Is prod down?" });
    await react(":eyes:").run(firedOn(item), source);
    await react("eyes").run(firedOn(item), source);
    await react("white_check_mark").run(firedOn(item), source);

    expect(slack.reactions(GENERAL, item.ts)).toEqual(["eyes", "white_check_mark"]);
    expect(slack.calls("reactions.add").map((call) => call.params.name)).toEqual(["eyes", "eyes", "white_check_mark"]);
    expect(react(":eyes:").describe(firedOn(item))).toBe("react with :eyes: to Ann Smith's message");
  });

  it("says which scope the app lacks", async () => {
    const item = await said({ channel: GENERAL, text: "Is prod down?" });
    slack.removeScope("reactions:write");

    await expect(react("eyes").run(firedOn(item), source)).rejects.toThrow(
      "Slack reactions.add failed: the app lacks the reactions:write scope. Add it under OAuth & Permissions → Scopes, reinstall the app, then run: npx jev-events auth slack",
    );
  });
});

describe("slack.post", () => {
  beforeEach(() => slack.addConversation({ id: "C0ALERTS", name: "alerts" }));

  it("posts an alert with what fired, who wrote what and where, and a link", async () => {
    const item = await said({ channel: GENERAL, text: "is 2 &lt; 3 &amp;&amp; prod down?" });
    const action = post("#alerts");
    await action.run(firedOn(item, "urgent"), source);
    const lookups = slack.calls("conversations.list").length;
    await action.run(firedOn(item, "urgent"), source);

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
    const item = await said({ channel: GENERAL, text: "Is prod down?" });
    await post("alerts", (event) => `${event.item.author.name} needs help`).run(firedOn(item), source);

    expect(postedParams()).toEqual([{ channel: "C0ALERTS", text: "Ann Smith needs help" }]);
  });

  it("says when there's no such channel, and finds it once there is", async () => {
    const item = await said({ channel: GENERAL, text: "Is prod down?" });
    const action = post("#incidents");

    await expect(action.run(firedOn(item), source)).rejects.toThrow("There's no #incidents channel that the app can see. If it's private, invite the app to it first.");
    slack.addConversation({ id: "C0INCIDENTS", name: "incidents" });
    await action.run(firedOn(item), source);
    expect(postedParams()).toMatchObject([{ channel: "C0INCIDENTS" }]);
  });

  it("says how to add the app to the channel", async () => {
    const item = await said({ channel: GENERAL, text: "Is prod down?" });

    await expect(post("off-topic").run(firedOn(item), source)).rejects.toThrow(
      "The app (@jev_events) isn't in #off-topic. In Slack, open #off-topic and type: /invite @jev_events",
    );
  });
});

it("says the actions need the Slack source", async () => {
  const item = await said({ channel: GENERAL, text: "Is prod down?" });
  const other = { id: "webhook", start: async () => {} } as unknown as Source<SlackMessageItem, string>;

  await expect(reply("On it.").run(firedOn(item), other)).rejects.toThrow("Slack actions need the Slack source: slack.messages({ auth }).");
});

describe("with listen()", () => {
  const needsAnswer = noul("Does this message need an answer from the team?");
  const jev = () => mockJev(({ state }) => ({ needsAnswer: JSON.stringify(state).includes("prod down") ? 0.95 : 0.05 }));

  it("only says what it would do in dry-run, the default", async () => {
    const actions: Array<ActionEvent<SlackMessageItem>> = [];
    const team = listen(source, { needsAnswer }, { client: jev(), log: silentLogger })
      .on("needsAnswer", react("eyes"))
      .on("action", (e) => void actions.push(e));
    await team.start();
    slack.post({ channel: GENERAL, text: "Is prod down?" });
    await waitFor(() => actions.length === 1);
    await team.stop();

    expect(actions.map((e) => [e.status, e.description])).toEqual([["dry-run", "react with :eyes: to Ann Smith's message"]]);
    expect(slack.calls("reactions.add")).toEqual([]);
  });

  it("reacts and alerts #alerts when armed, and leaves other messages alone", async () => {
    slack.addConversation({ id: "C0ALERTS", name: "alerts" });
    const actions: Array<ActionEvent<SlackMessageItem>> = [];
    const team = listen(source, { needsAnswer }, { client: jev(), dryRun: false, log: silentLogger })
      .on("needsAnswer", react("eyes"))
      .on("needsAnswer", post("#alerts"))
      .on("action", (e) => void actions.push(e));
    await team.start();
    const question = slack.post({ channel: GENERAL, text: "Is prod down?" });
    const other = slack.post({ channel: GENERAL, user: BOB, text: "Deploy done." });
    await waitFor(() => actions.length === 2);
    await team.stop();

    expect(actions.map((e) => e.status)).toEqual(["done", "done"]);
    expect(slack.reactions(GENERAL, question.ts)).toEqual(["eyes"]);
    expect(slack.reactions(GENERAL, other.ts)).toEqual([]);
    expect(slack.posted).toMatchObject([{ channel: "C0ALERTS", text: expect.stringContaining("*needsAnswer* · Ann Smith in #general: “Is prod down?”") }]);
  });
});
