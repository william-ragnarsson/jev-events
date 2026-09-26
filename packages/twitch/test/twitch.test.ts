import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import { listen, noul, silentLogger, type ActionEvent, type ErrorEvent } from "jev-events";
import { itemFromIrc, parseIrcLine, type TwitchChatItem } from "jev-events/public";
import { mockJev } from "jev-events/testing";

import { itemFromEventSub, twitch, withTokens } from "@jev-events/twitch";

const hateful = noul("Is this message hateful?");

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
});

describe("eventsub mapping", () => {
  it("maps channel.chat.message events", () => {
    const item = itemFromEventSub(
      {
        broadcaster_user_id: "1",
        broadcaster_user_login: "chan",
        chatter_user_id: "2",
        chatter_user_login: "modguy",
        chatter_user_name: "ModGuy",
        message_id: "m-1",
        message: { text: "hi" },
        message_type: "text",
        badges: [{ set_id: "lead_moderator" }],
        cheer: { bits: 100 },
        reply: null,
      },
      "2026-09-24T20:00:00Z",
    );
    expect(item).toMatchObject({ id: "m-1", bits: 100, firstMessage: false, author: { roles: ["moderator"] } });
  });
});

// ---------------------------------------------------------------------------
// A fake Twitch: EventSub over a local WebSocket server, Helix and OAuth via a fetch stub.
// ---------------------------------------------------------------------------

interface FakeTwitch {
  url: string;
  sockets: ServerSocket[];
  calls: Array<{ method: string; url: string; body: unknown }>;
  welcome(socket: ServerSocket, id: string): void;
  chat(socket: ServerSocket, text: string, chatter?: { id: string; login: string; badges?: string[] }): void;
  close(): Promise<void>;
}

async function fakeTwitch(): Promise<FakeTwitch> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const sockets: ServerSocket[] = [];
  const calls: FakeTwitch["calls"] = [];
  let sequence = 0;
  const send = (socket: ServerSocket, type: string, payload: unknown) =>
    socket.send(
      JSON.stringify({
        metadata: { message_id: `msg-${++sequence}`, message_type: type, message_timestamp: new Date().toISOString() },
        payload,
      }),
    );

  const fake: FakeTwitch = {
    url: `ws://127.0.0.1:${port}/ws`,
    sockets,
    calls,
    welcome: (socket, id) => send(socket, "session_welcome", { session: { id, keepalive_timeout_seconds: 10, reconnect_url: null } }),
    chat: (socket, text, chatter = { id: "42", login: "viewer" }) =>
      send(socket, "notification", {
        subscription: { type: "channel.chat.message", status: "enabled" },
        event: {
          broadcaster_user_id: "1000",
          broadcaster_user_login: "mychannel",
          chatter_user_id: chatter.id,
          chatter_user_login: chatter.login,
          chatter_user_name: chatter.login,
          message_id: `chat-${sequence}`,
          message: { text },
          message_type: "text",
          badges: (chatter.badges ?? []).map((set_id) => ({ set_id })),
          cheer: null,
          reply: null,
        },
      }),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.terminate();
        server.close(() => resolve());
      }),
  };
  server.on("connection", (socket) => {
    sockets.push(socket);
    fake.welcome(socket, `session-${sockets.length}`);
  });

  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method: init.method ?? "GET", url, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://id.twitch.tv/oauth2/validate")) {
      return json({ client_id: "cid", login: "jevbot", user_id: "999", scopes: ["user:read:chat", "moderator:manage:banned_users"] });
    }
    if (url.startsWith("https://api.twitch.tv/helix/users")) return json({ data: [{ id: "1000", login: "mychannel", display_name: "MyChannel" }] });
    if (url.startsWith("https://api.twitch.tv/helix/eventsub/subscriptions")) return json({ data: [{ id: "sub-1" }] }, 202);
    if (url.startsWith("https://api.twitch.tv/helix/moderation/bans")) return json({ data: [{}] });
    if (url.startsWith("https://api.twitch.tv/helix/moderation/chat")) return new Response(null, { status: 204 });
    return realFetch(input, init);
  });
  return fake;
}

const waitFor = async (condition: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("twitch.chat with auth", () => {
  it("subscribes over EventSub, survives a server-requested reconnect, and runs armed actions", async () => {
    const fake = await fakeTwitch();
    const auth = withTokens({ clientId: "cid", accessToken: "token" });
    const source = twitch.chat("MyChannel", { auth, eventsubUrl: fake.url });
    const texts: string[] = [];
    const actions: ActionEvent[] = [];
    const chat = listen(source, { hateful }, {
      client: mockJev(({ state }) => ({ hateful: (state as { message: { text: string } }).message.text.includes("idiot") ? 0.97 : 0.01 })),
      dryRun: false,
      log: silentLogger,
    })
      .on("judged", (e) => {
        texts.push(e.item.text);
      })
      .on("hateful", { min: 0.9 }, twitch.timeout({ seconds: 60 }))
      .on("hateful", { min: 0.9 }, twitch.deleteMessage())
      .on("action", (e) => {
        actions.push(e);
      });

    await chat.start();
    expect(source.session).toMatchObject({ broadcasterId: "1000", botId: "999", botLogin: "jevbot" });
    const subscriptions = () => fake.calls.filter((call) => call.url.includes("/eventsub/subscriptions"));
    expect(subscriptions()).toHaveLength(1);
    expect(subscriptions()[0]?.body).toMatchObject({
      type: "channel.chat.message",
      condition: { broadcaster_user_id: "1000", user_id: "999" },
      transport: { method: "websocket", session_id: "session-1" },
    });

    const first = fake.sockets[0] as ServerSocket;
    fake.chat(first, "hello chat");
    fake.chat(first, "you idiot");
    fake.chat(first, "a mod speaking, idiot", { id: "7", login: "amod", badges: ["moderator"] });
    fake.chat(first, "the bot itself", { id: "999", login: "jevbot" });
    fake.chat(first, "!uptime");
    await waitFor(() => texts.length === 3 && actions.length === 4);

    // Twitch asks us to move to a new connection; the subscription carries over.
    first.send(
      JSON.stringify({
        metadata: { message_id: "reconnect-1", message_type: "session_reconnect", message_timestamp: new Date().toISOString() },
        payload: { session: { id: "session-1", keepalive_timeout_seconds: null, reconnect_url: fake.url } },
      }),
    );
    await waitFor(() => fake.sockets.length === 2);
    await waitFor(() => first.readyState === first.CLOSED);
    fake.chat(fake.sockets[1] as ServerSocket, "after the move");
    await waitFor(() => texts.includes("after the move"));
    expect(subscriptions()).toHaveLength(1);

    await chat.stop();
    await fake.close();

    expect(texts).toEqual(["hello chat", "you idiot", "a mod speaking, idiot", "after the move"]);
    const byStatus = actions.map((e) => `${e.action}:${e.status}:${e.event.item.author?.name}`).sort();
    expect(byStatus).toEqual([
      "twitch.deleteMessage:done:viewer",
      "twitch.deleteMessage:skipped:amod",
      "twitch.timeout:done:viewer",
      "twitch.timeout:skipped:amod",
    ]);
    const ban = fake.calls.find((call) => call.url.includes("/moderation/bans"));
    expect(ban?.url).toContain("broadcaster_id=1000");
    expect(ban?.url).toContain("moderator_id=999");
    expect(ban?.body).toEqual({ data: { user_id: "42", duration: 60, reason: "jev-events: hateful (97%)" } });
    expect(fake.calls.find((call) => call.url.includes("/moderation/chat"))?.method).toBe("DELETE");
  });

  it("stops with a clear error when Twitch revokes the subscription", async () => {
    const fake = await fakeTwitch();
    const source = twitch.chat("mychannel", { auth: withTokens({ clientId: "cid", accessToken: "token" }), eventsubUrl: fake.url });
    const errors: ErrorEvent[] = [];
    const chat = listen(source, { hateful }, { client: mockJev(() => ({ hateful: 0 })), log: silentLogger }).on("error", (e) => {
      errors.push(e);
    });
    await chat.start();
    const finished = chat.run();

    // What Twitch sends when the user disconnects the app or changes their password.
    const socket = fake.sockets[0] as ServerSocket;
    socket.send(
      JSON.stringify({
        metadata: {
          message_id: "revocation-1",
          message_type: "revocation",
          message_timestamp: new Date().toISOString(),
          subscription_type: "channel.chat.message",
        },
        payload: { subscription: { type: "channel.chat.message", status: "authorization_revoked" } },
      }),
    );

    expect((await finished).errors).toBe(1);
    expect(errors.map((e) => [e.phase, (e.error as Error).message])).toEqual([
      ["source", "Twitch revoked the chat subscription (authorization_revoked). Sign in again: npx jev-events auth twitch"],
    ]);
    await waitFor(() => socket.readyState === socket.CLOSED);
    // It must not keep reconnecting with a revoked token; the first retry would come after 1s.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(fake.sockets).toHaveLength(1);
    await fake.close();
  });

  it("reads anonymously without auth, and only allows dry-run actions", async () => {
    const source = twitch.chat("somechannel");
    expect(source.canAct).toBe(false);
    const chat = listen(source, { hateful }, { client: mockJev(() => ({ hateful: 1 })), dryRun: false }).on("hateful", twitch.ban());
    await expect(chat.start()).rejects.toThrow(/isn't authenticated/);
  });
});

describe("auth", () => {
  it("refreshes an expiring token and hands back the rotated tokens", async () => {
    const saved: unknown[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
      expect(String(input)).toBe("https://id.twitch.tv/oauth2/token");
      const body = new URLSearchParams(String(init.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("client_secret")).toBeNull();
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 14_000 }));
    });
    const auth = withTokens(
      { clientId: "cid", accessToken: "old", refreshToken: "old-refresh", expiresAt: Date.now() + 1_000 },
      (tokens) => saved.push(tokens),
    );
    expect(await auth.token()).toBe("new-access");
    expect(saved).toEqual([expect.objectContaining({ accessToken: "new-access", refreshToken: "new-refresh" })]);
  });
});
