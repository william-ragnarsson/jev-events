import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { conversationLabel, Directory, SlackApi, SlackApiError, toConversation, toUser } from "@jev-events/slack";

import { kindFromChannelType } from "../src/directory.js";
import { ANN, ANN_DM, BOT_TOKEN, ERIN, fakeSlack, GENERAL, GUEST, OFF_TOPIC, RANDOM, TEAM, type FakeSlack } from "./fake-slack.js";

describe("toUser", () => {
  it("names people by display name, then full name, then handle", () => {
    expect(toUser({ id: "U1", name: "bob", real_name: "Bob Jones", profile: { display_name: "Bob", real_name: "Bob Jones" } }, "T1").name).toBe("Bob");
    expect(toUser({ id: "U1", name: "ann", real_name: "Ann Smith", profile: { display_name: "", real_name: "Ann Smith" } }, "T1").name).toBe("Ann Smith");
    expect(toUser({ id: "U1", name: "ann" }, "T1").name).toBe("ann");
    expect(toUser({ id: "U1" }, "T1")).toEqual({ id: "U1", name: "U1", guest: false, external: false, bot: false, roles: [] });
  });

  it("gives owners, admins, guests and bots their roles", () => {
    expect(toUser({ id: "U1", is_primary_owner: true, is_owner: true, is_admin: true }, "T1").roles).toEqual(["owner"]);
    expect(toUser({ id: "U1", is_admin: true }, "T1").roles).toEqual(["admin"]);
    expect(toUser({ id: "U1", is_restricted: true }, "T1")).toMatchObject({ guest: true, roles: ["guest"] });
    expect(toUser({ id: "U1", is_ultra_restricted: true }, "T1")).toMatchObject({ guest: true, roles: ["guest"] });
    expect(toUser({ id: "U1", is_bot: true }, "T1")).toMatchObject({ bot: true, roles: ["bot"] });
  });

  it("marks people from another workspace as external", () => {
    expect(toUser({ id: "U1", team_id: "T2" }, "T1").external).toBe(true);
    expect(toUser({ id: "U1", team_id: "T1" }, "T1").external).toBe(false);
  });
});

describe("toConversation", () => {
  it("tells channels, private channels, DMs and group DMs apart", () => {
    expect(toConversation({ id: "C1", name: "general", is_channel: true, is_member: true })).toEqual({ id: "C1", name: "general", kind: "channel", member: true });
    expect(toConversation({ id: "G1", name: "secret", is_group: true, is_member: false })).toEqual({ id: "G1", name: "secret", kind: "private", member: false });
    expect(toConversation({ id: "C2", name: "secret-2", is_channel: true, is_private: true, is_member: true }).kind).toBe("private");
    expect(toConversation({ id: "D1", is_im: true, user: "U1" })).toEqual({ id: "D1", kind: "dm", member: true, user: "U1" });
    expect(toConversation({ id: "G2", name: "mpdm-ann--bob-1", is_mpim: true })).toEqual({ id: "G2", kind: "group-dm", member: true });
  });

  it("maps the channel_type on events", () => {
    expect(["channel", "group", "im", "mpim", undefined].map(kindFromChannelType)).toEqual(["channel", "private", "dm", "group-dm", undefined]);
  });

  it("labels them the way people say them", () => {
    expect(conversationLabel({ id: "C1", name: "general", kind: "channel", member: true })).toBe("#general");
    expect(conversationLabel({ id: "C1", kind: "channel", member: true })).toBe("#C1");
    expect(conversationLabel({ id: "D1", kind: "dm", member: true })).toBe("DM");
    expect(conversationLabel({ id: "G1", kind: "group-dm", member: true })).toBe("group DM");
  });
});

describe("Directory", () => {
  let slack: FakeSlack;
  let warnings: string[];
  let directory: Directory;

  beforeEach(async () => {
    slack = await fakeSlack();
    warnings = [];
    directory = new Directory(new SlackApi(BOT_TOKEN), TEAM.id, (message) => void warnings.push(message));
  });

  afterEach(async () => {
    await slack.close();
  });

  it("looks each person up once", async () => {
    const [first, second] = await Promise.all([directory.user(ANN), directory.user(ANN)]);
    const third = await directory.user(ANN);

    expect(first).toEqual({ id: ANN, name: "Ann Smith", handle: "ann", guest: false, external: false, bot: false, roles: ["owner"] });
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(slack.calls("users.info")).toHaveLength(1);
  });

  it("knows guests and people from other companies", async () => {
    expect(await directory.user(GUEST)).toMatchObject({ name: "Gus Guest", guest: true, roles: ["guest"] });
    expect(await directory.user(ERIN)).toMatchObject({ name: "Erin Partner", external: true });
  });

  it("uses the ID when Slack can't say who it is, warns once, and asks again next time", async () => {
    expect(await directory.user("U0GONE")).toEqual({ id: "U0GONE", name: "U0GONE", guest: false, external: false, bot: false, roles: [] });
    await directory.user("U0GONE");
    await directory.user("U0GONE2");

    expect(warnings).toEqual(["Couldn't look up Slack user U0GONE: Slack users.info failed: user_not_found."]);
    expect(slack.calls("users.info")).toHaveLength(3);
  });

  it("fails when the token was revoked, rather than guessing", async () => {
    slack.revoke();

    await expect(directory.user(ANN)).rejects.toThrow(SlackApiError);
    await expect(directory.conversation(GENERAL)).rejects.toThrow("Slack signed this workspace out (token_revoked)");
  });

  it("looks conversations up once, and guesses the kind when Slack can't say", async () => {
    expect(await directory.conversation(GENERAL)).toEqual({ id: GENERAL, name: "general", kind: "channel", member: true });
    await directory.conversation(GENERAL);
    expect(slack.calls("conversations.info")).toHaveLength(1);

    expect(await directory.conversation("D0GONE")).toEqual({ id: "D0GONE", kind: "dm", member: true });
    expect(await directory.conversation("G0GONE", "group-dm")).toEqual({ id: "G0GONE", kind: "group-dm", member: true });
    expect(warnings).toEqual([
      "Couldn't look up Slack conversation D0GONE: Slack conversations.info failed: channel_not_found (there's no such channel, or the app can't see it).",
    ]);
  });

  it("lists every conversation the app is in, across pages, and remembers them", async () => {
    slack.addConversation({ id: "G0SECRET", name: "secret", kind: "private" });
    slack.addConversation({ id: "C0ARCHIVE", name: "old", archived: true });

    const mine = await directory.mine();

    expect(mine).toEqual([
      { id: GENERAL, name: "general", kind: "channel", member: true },
      { id: RANDOM, name: "random", kind: "channel", member: true },
      { id: ANN_DM, kind: "dm", member: true, user: ANN },
      { id: "G0SECRET", name: "secret", kind: "private", member: true },
    ]);
    expect(slack.calls("users.conversations")).toHaveLength(2);
    await directory.conversation("G0SECRET");
    expect(slack.calls("conversations.info")).toHaveLength(0);
  });

  it("finds a channel by name, #name or ID", async () => {
    expect(await directory.find("random")).toMatchObject({ id: RANDOM, member: true });
    expect(await directory.find("#Random")).toMatchObject({ id: RANDOM });
    expect(await directory.find(` ${GENERAL} `)).toMatchObject({ id: GENERAL, name: "general" });
    expect(await directory.find("off-topic")).toEqual({ id: OFF_TOPIC, name: "off-topic", kind: "channel", member: false });
  });

  it("finds a channel on a later page", async () => {
    for (const name of ["design", "eng", "sales", "support"]) slack.addConversation({ id: `C0${name.toUpperCase()}1`, name });

    expect(await directory.find("#support")).toMatchObject({ id: "C0SUPPORT1" });
    expect(slack.calls("conversations.list").length).toBeGreaterThan(1);
  });

  it("says when there's no such channel, or it's private and the app isn't in it", async () => {
    slack.addConversation({ id: "G0SECRET", name: "secret", kind: "private", members: [ANN] });

    await expect(directory.find("#nope")).rejects.toThrow("There's no #nope channel that the app can see. If it's private, invite the app to it first.");
    await expect(directory.find("secret")).rejects.toThrow("There's no #secret channel that the app can see.");
  });
});
