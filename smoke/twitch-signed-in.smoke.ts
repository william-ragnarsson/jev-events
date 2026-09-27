import { afterEach, describe, expect, it } from "vitest";

import {
  connectionInfo,
  fileStore,
  memoryStore,
  monitor,
  noul,
  silentLogger,
  type ActionContext,
  type ActionEvent,
  type Connection,
  type ErrorEvent,
  type TriggeredEvent,
} from "jev-events";
import { mockJev } from "jev-events/testing";

import { chat, DEFAULT_SCOPES, deleteMessage, fromEnv, say, timeout, type TwitchAuthor, type TwitchChatItem, type TwitchSession } from "@jev-events/twitch";

import { waitFor } from "./helpers.js";

// Twitch as your signed-in account, against a real channel, with Jev mocked. Reading runs whenever
// an account is connected. Saying something in chat, timing someone out and deleting a message run
// only with SMOKE_TWITCH_WRITE=1. See smoke/README.md.

// TWITCH_ACCESS_TOKEN (or TWITCH_REFRESH_TOKEN) when set, otherwise what `npx jev-events auth twitch`
// saved. That one is read from its store and renewed tokens are saved back, because Twitch accepts
// each refresh token only once.
const fromEnvironment = Boolean(process.env.TWITCH_ACCESS_TOKEN || process.env.TWITCH_REFRESH_TOKEN);
const store = fromEnvironment ? memoryStore() : fileStore();
const account: Connection | undefined = fromEnvironment
  ? fromEnv()
  : (await store.connections.list({ integration: "twitch" })).find((connection) => connection.status === "active");
if (account && fromEnvironment) await store.connections.save(account);

/** The channel to read. Default: the account's own. */
const channel = process.env.SMOKE_TWITCH_CHANNEL || undefined;
const target = process.env.SMOKE_TWITCH_TARGET || undefined;
const write = process.env.SMOKE_TWITCH_WRITE === "1";

const smokeTest = noul("Smoke test");
const reading = () => (channel ? chat(channel) : chat());
const running: Array<{ stop(): unknown }> = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((each) => each.stop()));
  await store.flush?.();
});

const errorsOf = (errors: ErrorEvent[]) => errors.map((event) => (event.error instanceof Error ? event.error.message : String(event.error)));

/** The account's session on the channel, opened the way a run opens it. */
async function openSession() {
  const source = reading();
  const controller = new AbortController();
  running.push({ stop: () => controller.abort() });
  // A run may have renewed the tokens since the account was read.
  const connection = (await store.connections.get(account!.id)) ?? account!;
  const session = (await source.session!({
    connection,
    app: undefined,
    log: silentLogger,
    signal: controller.signal,
    saveCredentials: async (credentials) => void (await store.connections.update(connection.id, { credentials })),
  })) as TwitchSession;
  const ctx: ActionContext<TwitchSession> = { session, connection: connectionInfo(connection), source, log: silentLogger, signal: controller.signal };
  return { session, ctx };
}

/** What fired on a message from `author`, to run an action on directly. */
function firedOn(session: TwitchSession, author: TwitchAuthor): TriggeredEvent<TwitchChatItem> {
  return {
    item: { id: "smoke", text: "jev-events smoke test", author, at: new Date(), channel: session.channel, channelId: session.broadcasterId, firstMessage: false },
    answers: {},
    connection: undefined,
    monitor: "smoke",
    model: "smoke",
    latencyMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    cached: false,
    dryRun: false,
    protected: false,
    trigger: { event: "smokeTest", question: "smokeTest" },
  };
}

describe.skipIf(!account)("twitch, signed in (real Twitch)", () => {
  it("signed in with every permission Jev Events asks for, and finds the channel", async () => {
    const { session } = await openSession();

    expect(DEFAULT_SCOPES.filter((scope) => !session.scopes.includes(scope)), "Sign in again: npx jev-events auth twitch").toEqual([]);
    expect(session.broadcasterId).toMatch(/^\d+$/);
    if (channel) expect(session.channel).toBe(channel.toLowerCase());
    else expect(session.channel).toBe(session.login);
  });

  it("subscribes to the channel's chat over EventSub", async () => {
    const errors: ErrorEvent[] = [];
    const mods = monitor({ id: "smoke:twitch", source: reading(), questions: { smokeTest }, client: mockJev(() => ({ smokeTest: 0 })), log: silentLogger }).on(
      "error",
      (event) => void errors.push(event),
    );
    running.push(mods);

    // Starting settles once Twitch confirmed the subscription.
    await mods.start({ store });
    expect(errorsOf(errors)).toEqual([]);
  }, 60_000);

  it.skipIf(!write)("says a line in chat, and Twitch doesn't drop it", async () => {
    const { session, ctx } = await openSession();
    const self = { id: session.userId, name: session.login, login: session.login, roles: [] };

    // Rejects when Twitch drops the message, such as for AutoMod.
    await say(`jev-events smoke test, ${new Date().toISOString()}`).run(firedOn(session, self), ctx);
  });

  it.skipIf(!write || !target)("times SMOKE_TWITCH_TARGET out for one second", async () => {
    const { session, ctx } = await openSession();
    const user = await session.helix.userByLogin(target!);
    if (!user) throw new Error(`There's no Twitch user called "${target}".`);

    await timeout({ seconds: 1, reason: "jev-events smoke test" }).run(firedOn(session, { id: user.id, name: user.display_name, login: user.login, roles: [] }), ctx);
  });

  it.skipIf(!write)('sees you type "jev test", then deletes the message', async () => {
    const done: Array<ActionEvent<TwitchChatItem>> = [];
    const errors: ErrorEvent[] = [];
    const mods = monitor({
      id: "smoke:twitch",
      source: reading(),
      questions: { smokeTest },
      client: mockJev(({ state }) => ({ smokeTest: /jev test/i.test((state as { message?: { text?: string } }).message?.text ?? "") ? 1 : 0 })),
      dryRun: false,
      log: silentLogger,
    })
      .on("smokeTest", deleteMessage())
      .on("action", (event) => void done.push(event))
      .on("error", (event) => void errors.push(event));
    running.push(mods);
    await mods.start({ store });

    const where = channel ? `https://www.twitch.tv/${channel}` : "your channel's chat";
    console.log(`Type a message with "jev test" in ${where}, from an account that isn't the broadcaster or a moderator. Waiting 2 minutes…`);
    await waitFor(() => done.length > 0 || errors.length > 0, 120_000, 'a message with "jev test"');

    expect(errorsOf(errors)).toEqual([]);
    expect(done.map((event) => [event.action, event.status, event.reason])).toEqual([["twitch.deleteMessage", "done", undefined]]);
  }, 150_000);
});
