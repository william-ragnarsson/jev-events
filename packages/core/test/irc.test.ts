import { describe, expect, it } from "vitest";

import {
  ignoredChat,
  isProtectedChatter,
  itemFromIrc,
  parseIrcLine,
  rolesFromBadges,
  type TwitchChatItem,
} from "../src/public/index.js";

// Twitch chat as IRC, which twitchChat() reads without signing in, and the chat rules both Twitch
// sources share: roles from badges, who's protected, and what's skipped before judging.

const PRIVMSG =
  "@badge-info=subscriber/14;badges=subscriber/12,vip/1;color=#FF0000;display-name=Viewer_One;emotes=;first-msg=1;" +
  "id=9d1e-44;mod=0;reply-parent-display-name=Streamer;reply-parent-msg-body=who\\swon?;room-id=1234;" +
  "tmi-sent-ts=1727200000000;user-id=5678 :viewer_one!viewer_one@viewer_one.tmi.twitch.tv PRIVMSG #somechannel :hello there";

describe("irc", () => {
  it("parses tags, prefix, command and trailing text", () => {
    const message = parseIrcLine(PRIVMSG);
    expect(message?.command).toBe("PRIVMSG");
    expect(message?.params).toEqual(["#somechannel", "hello there"]);
    expect(message?.tags["reply-parent-msg-body"]).toBe("who won?");
    expect(parseIrcLine("PING :tmi.twitch.tv")).toEqual({ tags: {}, command: "PING", params: ["tmi.twitch.tv"] });
  });

  it("maps a chat line to an item with roles and facts", () => {
    const item = itemFromIrc(parseIrcLine(PRIVMSG)!) as TwitchChatItem;
    expect(item).toMatchObject({
      id: "9d1e-44",
      text: "hello there",
      channel: "somechannel",
      channelId: "1234",
      firstMessage: true,
      author: { id: "5678", name: "Viewer_One", login: "viewer_one", roles: ["subscriber", "vip"] },
      reply: { author: "Streamer", text: "who won?" },
      facts: { firstMessage: true, replyingTo: { author: "Streamer", text: "who won?" } },
    });
    expect(item.at.getTime()).toBe(1727200000000);
  });

  it("unwraps /me actions", () => {
    const item = itemFromIrc(parseIrcLine(":a!a@a.tmi.twitch.tv PRIVMSG #c :\u0001ACTION waves\u0001")!);
    expect(item?.text).toBe("waves");
  });

  it("counts mod=1 as a moderator and skips lines that aren't chat", () => {
    const item = itemFromIrc(parseIrcLine("@mod=1;user-id=9 :m!m@m.tmi.twitch.tv PRIVMSG #c :hi")!);
    expect(item?.author.roles).toEqual(["moderator"]);
    expect(itemFromIrc(parseIrcLine(":tmi.twitch.tv 001 justinfan123 :Welcome, GLHF!")!)).toBeUndefined();
  });
});

describe("chat rules", () => {
  const said = (text: string, login = "viewer", roles: string[] = []): TwitchChatItem => ({
    id: "1",
    text,
    at: new Date(),
    channel: "mychannel",
    firstMessage: false,
    author: { id: "42", name: login, login, roles },
  });

  it("maps badges to the roles Jev Events uses", () => {
    expect(rolesFromBadges(["lead_moderator", "founder", "global_mod", "premium"])).toEqual(["moderator", "subscriber", "staff"]);
    expect(rolesFromBadges(["broadcaster", "vip", "subscriber"])).toEqual(["broadcaster", "vip", "subscriber"]);
  });

  it("protects the broadcaster, moderators, VIPs and staff, not subscribers", () => {
    for (const role of ["broadcaster", "moderator", "vip", "staff"]) expect(isProtectedChatter(said("hi", "a", [role]))).toBe(true);
    expect(isProtectedChatter(said("hi", "a", ["subscriber"]))).toBe(false);
  });

  it("skips commands and well-known bots unless told otherwise", () => {
    expect(ignoredChat(said("!uptime"))).toBe(true);
    expect(ignoredChat(said("hello", "Nightbot"))).toBe(true);
    expect(ignoredChat(said("hello"))).toBe(false);
    expect(ignoredChat(said("!uptime"), { commands: false })).toBe(false);
    expect(ignoredChat(said("hello", "nightbot"), { bots: false })).toBe(false);
    expect(ignoredChat(said("hello", "mybot"), { bots: ["mybot"] })).toBe(true);
  });
});
