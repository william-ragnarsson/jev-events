import { describe, expect, it } from "vitest";

import { botAuthor, channelTypeOf, MAX_TEXT_CHARS, messageItem, permalinkOf, type MessageContext, type SlackMessageEvent, type SlackUser } from "@jev-events/slack";
import { describeItem } from "jev-events";

const ann: SlackUser = { id: "U0ANN", name: "Ann Smith", handle: "ann", guest: false, external: false, bot: false, roles: ["owner"] };

function context(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    channel: { id: "C0GENERAL", name: "general", kind: "channel" },
    author: ann,
    me: "U0BOT",
    teamId: "T0ACME",
    url: "https://acme.slack.com/",
    ...overrides,
  };
}

function message(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return { type: "message", channel: "C0GENERAL", channel_type: "channel", user: "U0ANN", text: "Is prod down?", ts: "1760000000.000100", team: "T0ACME", ...overrides };
}

describe("messageItem", () => {
  it("says who wrote what, where and when, with a link to it", () => {
    const event = message();
    const item = messageItem(event, context());

    expect(item).toEqual({
      id: "C0GENERAL:1760000000.000100",
      text: "Is prod down?",
      author: { id: "U0ANN", name: "Ann Smith", roles: ["owner"], guest: false, external: false, bot: false },
      at: new Date(1_760_000_000_000),
      facts: { channel: "#general" },
      raw: event,
      channel: { id: "C0GENERAL", name: "general", kind: "channel" },
      ts: "1760000000.000100",
      inThread: false,
      mentions: [],
      mentionsYou: false,
      mentionsEveryone: false,
      permalink: "https://acme.slack.com/archives/C0GENERAL/p1760000000000100",
      files: [],
    });
  });

  it("gives Jev the text, the author, their roles and the facts", () => {
    const item = messageItem(message({ text: "<@U0BOT> is prod down? <!here>" }), context({ names: (id) => (id === "U0BOT" ? "Jev Events" : undefined) }));

    expect(describeItem(item)).toEqual({
      channel: "#general",
      mentionsYou: true,
      mentionsEveryone: true,
      text: "@Jev Events is prod down? @here",
      author: "Ann Smith",
      roles: ["owner"],
    });
  });

  it("writes mentions by name and keeps who was mentioned", () => {
    const names = (id: string) => ({ U0BOB: "Bob", C0RANDOM: "random" })[id];
    const item = messageItem(message({ text: "<@U0BOB> can you move this to <#C0RANDOM>?" }), context({ names }));

    expect(item.text).toBe("@Bob can you move this to #random?");
    expect(item.mentions).toEqual(["U0BOB"]);
    expect(item.mentionsYou).toBe(false);
    expect(item.facts).toEqual({ channel: "#general" });
  });

  it("knows a reply in a thread from the thread's first message", () => {
    const reply = messageItem(message({ ts: "1760000100.000200", thread_ts: "1760000000.000100" }), context());
    const first = messageItem(message({ thread_ts: "1760000000.000100" }), context());

    expect(reply).toMatchObject({ inThread: true, threadTs: "1760000000.000100", facts: { channel: "#general", inThread: true } });
    expect(reply.permalink).toBe("https://acme.slack.com/archives/C0GENERAL/p1760000100000200?thread_ts=1760000000.000100&cid=C0GENERAL");
    expect(first.inThread).toBe(false);
    expect(first).not.toHaveProperty("threadTs");
  });

  it("flags guests, people from other companies and bots", () => {
    const guest = messageItem(message(), context({ author: { ...ann, guest: true, roles: ["guest"] } }));
    const partner = messageItem(message({ user_team: "T0PARTNER" }), context({ author: { ...ann, roles: [] } }));
    const bot = messageItem(message(), context({ author: botAuthor(message({ user: undefined, bot_id: "B0DEPLOY", username: "Deploys" })) }));

    expect(guest.facts).toEqual({ channel: "#general", fromGuest: true });
    expect(guest.author.roles).toEqual(["guest"]);
    expect(partner.facts).toEqual({ channel: "#general", fromOtherCompany: true });
    expect(partner.author).toEqual({ id: "U0ANN", name: "Ann Smith", guest: false, external: true, bot: false });
    expect(bot.facts).toEqual({ channel: "#general", fromBot: true });
    expect(bot.author).toMatchObject({ id: "B0DEPLOY", name: "Deploys", bot: true, roles: ["bot"] });
  });

  it("lists attached files, in the text too, so Jev knows they're there", () => {
    const item = messageItem(
      message({ text: "Numbers for Q3", files: [{ name: "q3.pdf", mimetype: "application/pdf" }, { title: "Screenshot" }] }),
      context(),
    );

    expect(item.text).toBe("Numbers for Q3\n[file: q3.pdf]\n[file: Screenshot]");
    expect(item.files).toEqual([{ name: "q3.pdf", type: "application/pdf" }, { name: "Screenshot" }]);
    expect(item.facts?.files).toEqual(["q3.pdf", "Screenshot"]);
  });

  it("cuts very long messages", () => {
    const item = messageItem(message({ text: "x".repeat(MAX_TEXT_CHARS + 1_000) }), context());

    expect(item.text).toHaveLength(MAX_TEXT_CHARS + 1);
    expect(item.text.endsWith("x…")).toBe(true);
  });

  it("calls direct messages DMs", () => {
    const dm = messageItem(message({ channel: "D0ANNDM1", channel_type: "im" }), context({ channel: { id: "D0ANNDM1", kind: "dm" } }));
    const group = messageItem(message({ channel: "G0TRIO", channel_type: "mpim" }), context({ channel: { id: "G0TRIO", kind: "group-dm" } }));

    expect(dm.facts?.channel).toBe("DM");
    expect(dm.channel).toEqual({ id: "D0ANNDM1", kind: "dm" });
    expect(group.facts?.channel).toBe("group DM");
  });

  it("has no link without the workspace's address", () => {
    const { url: _url, ...rest } = context();

    expect(messageItem(message(), rest)).not.toHaveProperty("permalink");
  });
});

describe("botAuthor", () => {
  it("names a bot by its profile, then its username", () => {
    expect(botAuthor(message({ bot_id: "B0CI", bot_profile: { name: "CI" }, username: "ci-bot" }))).toEqual({
      id: "B0CI",
      name: "CI",
      guest: false,
      external: false,
      bot: true,
      roles: ["bot"],
    });
    expect(botAuthor(message({ bot_id: "B0CI", username: "ci-bot" })).name).toBe("ci-bot");
    expect(botAuthor(message()).name).toBe("bot");
  });
});

describe("permalinkOf", () => {
  it("works with or without a trailing slash on the workspace address", () => {
    expect(permalinkOf("https://acme.slack.com", "C0GENERAL", "1760000000.000100")).toBe("https://acme.slack.com/archives/C0GENERAL/p1760000000000100");
  });
});

describe("channelTypeOf", () => {
  it("gives the channel_type Slack uses on events", () => {
    expect(["channel", "private", "dm", "group-dm"].map((kind) => channelTypeOf(kind as never))).toEqual(["channel", "group", "im", "mpim"]);
  });
});
