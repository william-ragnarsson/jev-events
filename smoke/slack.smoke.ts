import { afterEach, describe, expect, it } from "vitest";

import { listen, noul, readCredentials, silentLogger, type AnySource, type Listener, type TriggeredEvent } from "jev-events";
import { mockJev } from "jev-events/testing";

import { fromEnv, fromFile, messages, react, reply, type SlackAuth, type SlackMessageItem } from "@jev-events/slack";

import { waitFor } from "./helpers.js";

// Slack against your real workspace. Reading runs whenever the app is connected; reacting and
// replying run only with SMOKE_SLACK_WRITE=1, to a message you type. See smoke/README.md.

const connected = Boolean(process.env.SLACK_BOT_TOKEN || readCredentials("slack"));
const write = process.env.SMOKE_SLACK_WRITE === "1";

/** SLACK_BOT_TOKEN and SLACK_APP_TOKEN when set, otherwise what `npx jev-events auth slack` saved. */
const auth = (): SlackAuth => (process.env.SLACK_BOT_TOKEN ? fromEnv() : fromFile());

let running: Array<Listener<AnySource, Record<string, ReturnType<typeof noul>>>> = [];

afterEach(async () => {
  await Promise.all(running.map((listener) => listener.stop()));
  running = [];
});

/** Start `source` with Jev mocked, and collect what it emits. */
async function watch(source: AnySource): Promise<SlackMessageItem[]> {
  const items: SlackMessageItem[] = [];
  const listener = listen(source, { check: noul("Smoke test") }, { client: mockJev(() => ({ check: 0 })), log: silentLogger }).on("judged", (event) => {
    items.push(event.item as SlackMessageItem);
  });
  running.push(listener);
  await listener.start();
  return items;
}

function firedOn(item: SlackMessageItem): TriggeredEvent<SlackMessageItem> {
  return {
    item,
    answers: {},
    model: "smoke",
    latencyMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    cached: false,
    dryRun: false,
    protected: false,
    trigger: { event: "smoke", question: "smoke" },
  };
}

describe.skipIf(!connected)("slack, connected (a real workspace)", () => {
  it("connects over Socket Mode and reads the latest messages", async () => {
    // Starting proves both tokens, the scopes to list conversations, and the Socket Mode connection.
    const source = messages({ auth: auth(), backfill: 3 });
    const items = await watch(source);

    expect(source.session?.team).toBeTruthy();
    expect(source.session?.user).toBeTruthy();
    // The latest messages are a bonus: the app may only be in quiet channels.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    for (const item of items) {
      expect(item.text.trim()).not.toBe("");
      expect(item.author.name).toBeTruthy();
      expect(item.permalink).toMatch(/^https:\/\//);
    }
  });

  it.skipIf(!write)('sees you type "jev test", then reacts and replies in its thread', async () => {
    const source = messages({ auth: auth() });
    const items = await watch(source);
    console.log(`Type a message with "jev test" in a channel @${source.session?.user} is in, or DM it. Waiting 2 minutes…`);

    const said = (item: SlackMessageItem) => /jev test/i.test(item.text);
    await waitFor(() => items.some(said), 120_000, 'a message with "jev test"');
    const item = items.find(said)!;
    await react("eyes").run(firedOn(item), source);
    await reply("jev-events smoke test: seen, and reacted with :eyes:.").run(firedOn(item), source);
  });
});
