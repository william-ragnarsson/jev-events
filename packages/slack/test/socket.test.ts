import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Logger } from "jev-events";
import { SlackApi, socketMode, SocketModeError, type EventCallback } from "@jev-events/slack";

import { ANN, APP_TOKEN, BOT_TOKEN, fakeSlack, GENERAL, type FakeSlack } from "./fake-slack.js";
import { waitFor } from "./helpers.js";

let slack: FakeSlack;
let controller: AbortController;
let events: EventCallback[];
let fatal: Error[];
let logs: string[];

const log: Logger = {
  debug: () => {},
  info: (message) => void logs.push(message),
  warn: (message) => void logs.push(message),
  error: (message) => void logs.push(message),
};

beforeEach(async () => {
  slack = await fakeSlack();
  controller = new AbortController();
  events = [];
  fatal = [];
  logs = [];
});

afterEach(async () => {
  controller.abort();
  await slack.close();
});

function connect(options: { token?: string; helloTimeoutMs?: number } = {}): Promise<void> {
  return socketMode({
    api: new SlackApi(options.token ?? APP_TOKEN),
    signal: controller.signal,
    log,
    onEvent: (payload) => void events.push(payload),
    onFatal: (error) => void fatal.push(error),
    ...(options.helloTimeoutMs ? { helloTimeoutMs: options.helloTimeoutMs } : {}),
  });
}

const texts = () => events.map((payload) => payload.event?.text);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("socketMode", () => {
  it("connects, hands on each event and acknowledges it", async () => {
    await connect();
    slack.post({ channel: GENERAL, text: "one" });
    slack.post({ channel: GENERAL, text: "two" });
    await waitFor(() => events.length === 2 && slack.acks.length === 2);

    expect(slack.connections).toEqual(["open 1"]);
    expect(texts()).toEqual(["one", "two"]);
    expect(events[0]).toMatchObject({ type: "event_callback", team_id: "T0ACME", event: { type: "message", channel: GENERAL, user: ANN, text: "one" } });
    expect(slack.acks).toEqual(slack.sent);
    expect(logs).toEqual([]);
  });

  it.each(["refresh_requested", "warning"])("opens a new connection before closing the old one when Slack says %s", async (reason) => {
    await connect();
    slack.disconnect(reason);
    slack.post({ channel: GENERAL, text: "during the swap" });
    await waitFor(() => slack.connections.includes("close 1"), 2_000, "the old connection to close");
    slack.post({ channel: GENERAL, text: "after the swap" });
    await waitFor(() => events.length === 2 && slack.acks.length === 2);

    expect(slack.connections).toEqual(["open 1", "open 2", "close 1"]);
    expect(texts()).toEqual(["during the swap", "after the swap"]);
    expect(slack.acks).toEqual(slack.sent);
    expect(logs).toEqual([]);
  });

  it("reconnects when the connection drops, and gets what Slack sent meanwhile", async () => {
    await connect();
    slack.delay("apps.connections.open", 100);
    slack.dropSockets();
    await waitFor(() => slack.sockets === 0);
    slack.post({ channel: GENERAL, text: "while away" });
    await waitFor(() => events.length === 1, 3_000, "the event sent while away");

    expect(texts()).toEqual(["while away"]);
    expect(slack.connections).toEqual(["open 1", "close 1", "open 2"]);
    expect(logs).toEqual(["slack: disconnected, reconnecting"]);
  });

  it("keeps trying when reconnecting fails, waiting longer each time", async () => {
    await connect();
    slack.fail("apps.connections.open", "internal_error");
    const dropped = Date.now();
    slack.dropSockets();
    await waitFor(() => slack.connections.includes("open 2"), 4_000, "the second try");

    expect(Date.now() - dropped).toBeGreaterThanOrEqual(900);
    expect(slack.calls("apps.connections.open")).toHaveLength(3);
    expect(logs).toEqual([
      "slack: disconnected, reconnecting",
      "slack: couldn't reconnect (Slack apps.connections.open failed: internal_error.), trying again",
    ]);
    expect(fatal).toEqual([]);
  });

  it("reconnects when a refresh fails", async () => {
    await connect();
    slack.fail("apps.connections.open", "internal_error");
    slack.disconnect("refresh_requested");
    await waitFor(() => slack.connections.includes("open 2") && slack.sockets === 1, 2_000, "the new connection");
    slack.post({ channel: GENERAL, text: "after" });
    await waitFor(() => events.length === 1);

    expect(logs).toEqual(["slack: couldn't refresh the connection (Slack apps.connections.open failed: internal_error.), reconnecting"]);
  });

  it("stops for good when Socket Mode is turned off", async () => {
    await connect();
    slack.disconnect("link_disabled");
    await waitFor(() => fatal.length === 1 && slack.sockets === 0);
    await pause(50);

    expect(fatal[0]?.message).toBe("Socket Mode is off for this Slack app. Turn it on under Settings → Socket Mode, then try again.");
    expect(slack.calls("apps.connections.open")).toHaveLength(1);
  });

  it("stops for good when the app-level token stops working", async () => {
    await connect();
    slack.revokeAppToken();
    slack.dropSockets();
    await waitFor(() => fatal.length === 1);

    expect(fatal[0]).toBeInstanceOf(SocketModeError);
    expect(fatal[0]?.message).toBe("Slack refused the app-level token (token_revoked): it was revoked or isn't valid.");
  });

  it("gives up on a connection Slack never says hello on", async () => {
    await slack.close();
    slack = await fakeSlack({ silent: true });

    await expect(connect({ helloTimeoutMs: 100 })).rejects.toThrow("Slack didn't answer on the Socket Mode connection.");
  });

  it.each([
    ["the bot token", () => ({ token: BOT_TOKEN }), "Socket Mode needs the app-level token (xapp-…), from Basic Information → App-Level Tokens, not the xoxb- token."],
    ["a wrong token", () => ({ token: "xapp-1-wrong" }), "Slack refused the app-level token (invalid_auth): it was revoked or isn't valid."],
    [
      "a token without connections:write",
      () => (slack.appTokenWithoutScope(), {}),
      "The app-level token lacks the connections:write scope. Make a new one under Basic Information → App-Level Tokens with that scope.",
    ],
  ])("says which token to fix, given %s", async (_, setup, message) => {
    const error = await connect(setup()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SocketModeError);
    expect((error as Error).message).toBe(message);
    expect(slack.sockets).toBe(0);
  });

  it("closes the connection when stopped, and doesn't come back", async () => {
    await connect();
    controller.abort();
    await waitFor(() => slack.sockets === 0);
    await pause(50);

    expect(slack.calls("apps.connections.open")).toHaveLength(1);
    expect(logs).toEqual([]);
  });
});
