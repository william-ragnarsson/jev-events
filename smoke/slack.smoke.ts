import { afterEach, describe, expect, it } from "vitest";

import { fileStore, memoryStore, monitor, noul, silentLogger, type ActionEvent, type Connection, type ErrorEvent } from "jev-events";
import { mockJev } from "jev-events/testing";

import { fromEnv, messages, react, reply, type SlackMessageItem } from "@jev-events/slack";

import { waitFor } from "./helpers.js";

// Slack against your real workspace, with Jev mocked. Reading runs whenever a workspace is
// connected; reacting and replying run only with SMOKE_SLACK_WRITE=1, to a message you type.
// See smoke/README.md.

/** SLACK_BOT_TOKEN (and SLACK_APP_TOKEN) when set, otherwise what `npx jev-events auth slack` saved. */
const account: Connection | undefined = process.env.SLACK_BOT_TOKEN
  ? fromEnv()
  : (await fileStore().connections.list({ integration: "slack" })).find((connection) => connection.status === "active");
const socketMode = typeof account?.credentials.appToken === "string";
const write = process.env.SMOKE_SLACK_WRITE === "1";

const smokeTest = noul("Smoke test");
const running: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((team) => team.stop()));
});

const errorsOf = (errors: ErrorEvent[]) => errors.map((event) => (event.error instanceof Error ? event.error.message : String(event.error)));

describe.skipIf(!account)("slack, connected (a real workspace)", () => {
  it(`reads the latest messages${socketMode ? ", after opening Socket Mode" : ""}`, async () => {
    // Reading proves the bot token and its scopes; with an app-level token, the run also waits for
    // Socket Mode to connect.
    const judged: SlackMessageItem[] = [];
    const errors: ErrorEvent[] = [];
    await monitor({ source: messages({ backfill: 3 }), questions: { smokeTest }, client: mockJev(() => ({ smokeTest: 0 })), log: silentLogger })
      .on("judged", (event) => void judged.push(event.item))
      .on("error", (event) => void errors.push(event))
      .run({ store: memoryStore(), connections: [account!] });

    expect(errorsOf(errors)).toEqual([]);
    // The latest messages are a bonus: the app may only be in quiet channels.
    for (const item of judged) {
      expect(item.text.trim()).not.toBe("");
      expect(item.author.name).toBeTruthy();
      expect(item.permalink).toMatch(/^https:\/\//);
    }
  }, 60_000);

  it.skipIf(!write || !socketMode)('sees you type "jev test", then reacts and replies in its thread', async () => {
    const done: Array<ActionEvent<SlackMessageItem>> = [];
    const errors: ErrorEvent[] = [];
    const team = monitor({
      source: messages(),
      questions: { smokeTest },
      client: mockJev(({ state }) => ({ smokeTest: /jev test/i.test(JSON.stringify(state)) ? 1 : 0 })),
      dryRun: false,
      log: silentLogger,
    })
      .on("smokeTest", react("eyes"))
      .on("smokeTest", reply("jev-events smoke test: seen, and reacted with :eyes:."))
      .on("action", (event) => void (event.status === "done" && done.push(event)))
      .on("error", (event) => void errors.push(event));
    running.push(team);
    await team.start({ store: memoryStore(), connections: [account!] });

    const user = account!.facts?.user;
    console.log(`Type a message with "jev test" in a channel ${typeof user === "string" ? `@${user}` : "the app"} is in, or DM it. Waiting 2 minutes…`);
    await waitFor(() => done.length === 2 || errors.length > 0, 120_000, 'a message with "jev test"');

    expect(errorsOf(errors)).toEqual([]);
    expect(done.map((event) => event.description).sort()).toEqual([
      expect.stringMatching(/^react with :eyes: to /),
      expect.stringMatching(/^reply /),
    ]);
  }, 150_000);
});
