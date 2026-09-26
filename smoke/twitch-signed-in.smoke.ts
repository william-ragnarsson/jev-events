import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { listen, noul, silentLogger, type ActionEvent, type Listener, type TriggeredEvent } from "jev-events";
import type { TwitchAuthor, TwitchChatItem } from "jev-events/public";
import { mockJev } from "jev-events/testing";

import { DEFAULT_SCOPES, fromEnv, fromFile, twitch, type TwitchAuth, type TwitchChatSource, type TwitchSession } from "@jev-events/twitch";

import { waitFor } from "./helpers.js";

// Twitch with a signed-in bot account, against a real channel: EventSub chat and native actions.
// Opt-in, because it posts in chat and can time out and delete messages. See smoke/README.md.

const channel = process.env.SMOKE_TWITCH_CHANNEL ?? "";
const target = process.env.SMOKE_TWITCH_TARGET ?? "";
const interactive = process.env.SMOKE_TWITCH_INTERACTIVE === "1";

/** TWITCH_CLIENT_ID and TWITCH_ACCESS_TOKEN when set, otherwise what `npx jev-events auth twitch` saved. */
function signIn(): TwitchAuth {
  return process.env.TWITCH_ACCESS_TOKEN ? fromEnv() : fromFile();
}

/** An outcome firing on a message from `author`, for running an action directly. */
function firedOn(author: TwitchAuthor): TriggeredEvent<TwitchChatItem> {
  return {
    item: { id: "smoke", text: "jev-events smoke test", author, at: new Date(), channel, firstMessage: false },
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

const questions = { test: noul('Does this message contain "jev test"?') };

describe.skipIf(!channel)("twitch, signed in (real Twitch)", () => {
  const actions: ActionEvent[] = [];
  let auth: TwitchAuth;
  let source: TwitchChatSource;
  let chat: Listener<TwitchChatSource, typeof questions>;
  const session = () => source.session as TwitchSession;

  beforeAll(() => {
    auth = signIn();
    source = twitch.chat(channel, { auth });
    // Jev is mocked: a message fires `test` when it contains "jev test".
    const client = mockJev(({ state }) => ({ test: (state as { message: { text: string } }).message.text.toLowerCase().includes("jev test") ? 1 : 0 }));
    chat = listen(source, questions, { client, dryRun: !interactive, log: silentLogger }).on("action", (event) => {
      actions.push(event);
    });
    if (interactive) chat.on("test", twitch.deleteMessage());
  });

  afterAll(async () => {
    await chat?.stop();
  });

  it("has a token with every scope Jev Events asks for", async () => {
    const identity = await auth.identity();
    const missing = DEFAULT_SCOPES.filter((scope) => !identity.scopes.includes(scope));
    expect(missing, "Sign in again: npx jev-events auth twitch").toEqual([]);
  });

  it("subscribes to the channel's chat over EventSub", async () => {
    await chat.start();
    const identity = await auth.identity();
    expect(source.session).toMatchObject({ botId: identity.userId, botLogin: identity.login });
    expect(session().broadcasterId).toMatch(/^\d+$/);
  });

  it("says something in chat", async () => {
    const call = vi.spyOn(session().helix, "call");
    const bot = { id: session().botId, name: session().botLogin, login: session().botLogin, roles: [] };
    await twitch.say(`jev-events smoke test, ${new Date().toISOString()}`).run(firedOn(bot), source);

    // Twitch answers 200 even when it drops a message, e.g. for AutoMod, so check what it said.
    const response = (await call.mock.results[0]?.value) as { data: Array<{ is_sent: boolean; drop_reason?: { message: string } | null }> };
    call.mockRestore();
    expect(response.data[0]?.is_sent, response.data[0]?.drop_reason?.message).toBe(true);
  });

  it.skipIf(!target)("times out SMOKE_TWITCH_TARGET for one second", async () => {
    const user = await session().helix.userByLogin(target);
    if (!user) throw new Error(`There's no Twitch user called "${target}".`);
    const author = { id: user.id, name: user.display_name, login: user.login, roles: [] };
    await twitch.timeout({ seconds: 1, reason: "jev-events smoke test" }).run(firedOn(author), source);
  });

  it.skipIf(!interactive)(
    "deletes a message you type in chat",
    async () => {
      console.info(
        `\n  Type a message containing "jev test" in https://www.twitch.tv/${channel}\n  from an account that isn't the broadcaster or a moderator. Waiting 2 minutes…\n`,
      );
      await waitFor(() => actions.length > 0, 120_000, 'a chat message containing "jev test"');
      expect(actions[0]?.action).toBe("twitch.deleteMessage");
      expect(actions[0]?.status, actions[0]?.reason).toBe("done");
    },
    150_000,
  );
});
