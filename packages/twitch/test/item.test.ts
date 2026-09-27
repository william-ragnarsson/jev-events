import { describe, expect, it } from "vitest";

import { itemFromEventSub, type ChatMessageEvent } from "@jev-events/twitch";

const event = (overrides: Partial<ChatMessageEvent> = {}): ChatMessageEvent => ({
  broadcaster_user_id: "1000",
  broadcaster_user_login: "mychannel",
  chatter_user_id: "42",
  chatter_user_login: "viewer",
  chatter_user_name: "Viewer",
  message_id: "m-1",
  message: { text: "hello there" },
  message_type: "text",
  badges: [],
  cheer: null,
  reply: null,
  ...overrides,
});

describe("itemFromEventSub", () => {
  it("maps a channel.chat.message event to a chat item", () => {
    const raw = event();
    const item = itemFromEventSub(raw, "2026-09-24T20:00:00Z");

    expect(item).toEqual({
      id: "m-1",
      text: "hello there",
      author: { id: "42", name: "Viewer", login: "viewer", roles: [] },
      at: new Date("2026-09-24T20:00:00Z"),
      channel: "mychannel",
      channelId: "1000",
      firstMessage: false,
      raw,
    });
  });

  it("maps badges to roles, so moderators and VIPs are protected", () => {
    const item = itemFromEventSub(event({ badges: [{ set_id: "lead_moderator" }, { set_id: "founder" }, { set_id: "vip" }] }), "2026-09-24T20:00:00Z");
    expect(item.author.roles).toEqual(["moderator", "subscriber", "vip"]);
  });

  it("tells Jev about first-time chatters and what a message replies to", () => {
    const item = itemFromEventSub(
      event({ message_type: "user_intro", reply: { parent_user_name: "MyChannel", parent_message_body: "who won?" } }),
      "2026-09-24T20:00:00Z",
    );

    expect(item).toMatchObject({
      firstMessage: true,
      reply: { author: "MyChannel", text: "who won?" },
      facts: { firstMessage: true, replyingTo: { author: "MyChannel", text: "who won?" } },
    });
  });

  it("keeps the bits cheered with a message", () => {
    const item = itemFromEventSub(event({ badges: [{ set_id: "lead_moderator" }], cheer: { bits: 100 } }), "2026-09-24T20:00:00Z");
    expect(item).toMatchObject({ id: "m-1", bits: 100, firstMessage: false, author: { roles: ["moderator"] } });
    expect(item.facts).toBeUndefined();
  });
});
