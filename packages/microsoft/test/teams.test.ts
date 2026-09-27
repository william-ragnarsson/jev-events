import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { messages, react, reply, type MessagesOptions } from "@jev-events/microsoft";
import { needsSignIn } from "jev-events";

import { fakeMicrosoft, type FakeMicrosoft, type FakePerson } from "./fake-microsoft.js";
import { checker, connectionTo, firedOn } from "./helpers.js";

let microsoft: FakeMicrosoft;

beforeEach(async () => {
  microsoft = await fakeMicrosoft();
});

afterEach(async () => {
  await microsoft.close();
});

const ann: FakePerson = { name: "Ann Lee", email: "ann@acme.com" };
const guest: FakePerson = { name: "Gus Guest", email: "gus@partner.com", tenantId: "tenant-partner" };
const watch = (options: MessagesOptions = {}, connection = connectionTo(microsoft)) => checker(messages(options), { connection });
const texts = (items: Array<{ text: string }>) => items.map((item) => item.text);

describe("teams.messages()", () => {
  it("starts from now, then emits what others write, skipping yours, bots and system messages", async () => {
    const launch = microsoft.addChat({ topic: "Launch", members: [ann] });
    microsoft.say(launch, { from: ann, text: "Before" });
    const chat = watch();

    await chat.check();
    microsoft.say(launch, { from: ann, text: "Can you review the plan?" });
    microsoft.say(launch, { from: "me", text: "Mine" });
    microsoft.say(launch, { from: { app: "Deploy bot" }, text: "Deployed" });
    microsoft.say(launch, { from: ann, text: "Ann joined", messageType: "systemEventMessage" });
    await chat.check();

    expect(texts(chat.items)).toEqual(["Can you review the plan?"]);
    expect(chat.items[0]).toMatchObject({ author: { name: "Ann Lee", bot: false, guest: false }, chat: { id: launch, name: "Launch", kind: "group" }, mentionsYou: false });
    expect(chat.errors).toEqual([]);
  });

  it("backfills the latest few messages, and includes bots when asked", async () => {
    const launch = microsoft.addChat({ topic: "Launch", members: [ann] });
    microsoft.say(launch, { from: ann, text: "One" });
    microsoft.say(launch, { from: ann, text: "Two" });
    microsoft.say(launch, { from: { app: "Deploy bot" }, text: "Deployed" });

    const chat = watch({ backfill: 2, includeBots: true });
    await chat.check();

    expect(texts(chat.items)).toEqual(["Two", "Deployed"]);
    expect(chat.items[1]?.author.bot).toBe(true);
  });

  it("doesn't emit a message again when it's edited or reacted to, and skips deleted ones", async () => {
    const launch = microsoft.addChat({ topic: "Launch", members: [ann] });
    const chat = watch();
    await chat.check();
    const first = microsoft.say(launch, { from: ann, text: "First" });
    await chat.check();

    microsoft.edit(launch, first, "First, edited");
    microsoft.react(launch, first);
    microsoft.deleteMessage(launch, microsoft.say(launch, { from: ann, text: "Oops" }));
    await chat.check();
    await chat.check();

    expect(texts(chat.items)).toEqual(["First"]);
  });

  it("describes mentions, quotes, files and guests", async () => {
    const launch = microsoft.addChat({ topic: "Launch", members: [ann, guest] });
    const chat = watch();
    await chat.check();
    const question = microsoft.say(launch, { from: ann, text: "Is the deck ready?" });
    microsoft.say(launch, { from: guest, text: "Me Myself, see the deck", mentions: ["me"], quote: question, files: ["deck.pptx"] });

    await chat.check();

    expect(chat.items[1]).toMatchObject({
      author: { name: "Gus Guest", external: true },
      mentionsYou: true,
      replyTo: { id: question },
      files: ["deck.pptx"],
    });
  });

  it("reads only the chats it's told to, by topic or by the other person", async () => {
    const launch = microsoft.addChat({ topic: "Launch", members: [ann] });
    const dm = microsoft.addChat({ type: "oneOnOne", members: [guest] });
    const other = microsoft.addChat({ topic: "Random", members: [ann] });
    const chat = watch({ chats: ["Launch", "gus@partner.com"] });
    await chat.check();

    for (const id of [launch, dm, other]) microsoft.say(id, { from: id === dm ? guest : ann, text: `In ${id}` });
    await chat.check();

    expect(texts(chat.items).sort()).toEqual([`In ${dm}`, `In ${launch}`].sort());
    expect(chat.items.find((item) => item.chat.id === dm)?.chat.kind).toBe("dm");
  });

  it("stops for a personal account, which has no Teams chats", async () => {
    await microsoft.close();
    microsoft = await fakeMicrosoft({ personal: true, me: "me@outlook.com" });
    const chat = watch();

    await expect(chat.check()).rejects.toThrow(
      "Teams chats need a work or school account, and me@outlook.com is a personal Microsoft account. Sign in with a work or school account: npx jev-events auth microsoft",
    );
    expect(chat.errors.map((e) => e.fatal)).toEqual([true]);
  });

  it("needs a new sign-in when the account didn't allow reading chats", async () => {
    const chat = watch({}, connectionTo(microsoft, { scopes: ["openid", "User.Read", "Mail.ReadWrite"] }));

    const error = await chat.check().then(() => undefined, (e: unknown) => e);

    expect(needsSignIn(error)).toBe(true);
  });
});

describe("Teams actions", () => {
  it("replies in the chat and reacts to the message", async () => {
    const launch = microsoft.addChat({ topic: "Launch", members: [ann] });
    const chat = watch();
    await chat.check();
    const id = microsoft.say(launch, { from: ann, text: "Ship it?" });
    await chat.check();
    const event = firedOn(chat.items[0]!);
    const ctx = await chat.actionContext();

    await reply((e) => `Yes, ${e.item.author.name}!`).run(event, ctx);
    await react("like").run(event, ctx);

    expect(microsoft.calls(`POST /chats/${launch}/messages`)[0]?.body).toEqual({ body: { contentType: "text", content: "Yes, Ann Lee!" } });
    expect(microsoft.calls(`POST /chats/${launch}/messages/${id}/setReaction`)[0]?.body).toEqual({ reactionType: "👍" });
    expect(reply("x").describe(event)).toBe("reply to Ann Lee in Launch");
    expect(react("👍").describe(event)).toBe("react 👍 to Ann Lee's message in Launch");
    expect(() => react(" ")).toThrow('react() takes an emoji, such as react("👍").');
    await expect(reply("x").run(event, { ...ctx, session: undefined as never })).rejects.toThrow("Teams actions run on items from microsoft.teams.messages().");
  });
});
