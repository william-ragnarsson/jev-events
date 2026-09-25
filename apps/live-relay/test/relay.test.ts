import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import { DailyBudget, silentLogger } from "jev-events";
import { mockJev } from "jev-events/testing";

import { fixedChannels, liveChannels } from "../src/channels.js";
import { Relay, scrub, type FeedEntry, type RelayOptions, type RelayStatus } from "../src/relay.js";
import { createRelayServer } from "../src/server.js";

/** A fake Twitch IRC endpoint: answers JOIN with ROOMSTATE and lets the test speak in chat. */
async function fakeIrc() {
  const server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const joined: string[] = [];
  const sockets = new Map<string, ServerSocket>();
  let id = 0;
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      for (const line of String(data).split("\r\n")) {
        const join = /^JOIN #(\w+)/.exec(line);
        if (!join?.[1]) continue;
        joined.push(join[1]);
        sockets.set(join[1], socket);
        socket.send(`@room-id=1 :tmi.twitch.tv ROOMSTATE #${join[1]}\r\n`);
      }
    });
    socket.on("close", () => {
      for (const [channel, open] of sockets) if (open === socket) sockets.delete(channel);
    });
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    joined,
    isOpen: (channel: string) => sockets.has(channel),
    say(channel: string, user: string, text: string) {
      const tags = `id=msg-${++id};user-id=${user}-id;display-name=${user};tmi-sent-ts=${Date.now()}`;
      sockets.get(channel)?.send(`@${tags} :${user}!${user}@${user}.tmi.twitch.tv PRIVMSG #${channel} :${text}\r\n`);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of server.clients) socket.terminate();
        server.close(() => resolve());
      }),
  };
}

const jev = mockJev(({ state }) => {
  const text = (state as { message: { text: string } }).message.text;
  return {
    hateful: text.includes("vile") ? 0.97 : 0.02,
    kind: text.endsWith("?") ? { question: 0.9, other: 0.1 } : "hype",
  };
});

const waitFor = async (condition: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

function viewer() {
  const messages: FeedEntry[] = [];
  const statuses: RelayStatus[] = [];
  let hello: { status: RelayStatus; recent: FeedEntry[] } | undefined;
  return {
    messages,
    statuses,
    get hello() {
      return hello;
    },
    send(event: string, data: unknown) {
      if (event === "hello") hello = data as typeof hello;
      if (event === "message") messages.push(data as FeedEntry);
      if (event === "status") statuses.push(data as RelayStatus);
    },
  };
}

const relays: Relay[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function setup(options: Partial<RelayOptions> = {}, channels = ["alpha"]) {
  const irc = await fakeIrc();
  cleanups.push(irc.close);
  const relay = new Relay({
    channels: fixedChannels(channels),
    budget: new DailyBudget(1_000_000),
    client: jev,
    chat: { endpoint: irc.url },
    log: silentLogger,
    tickMs: 20,
    ...options,
  });
  relays.push(relay);
  return { irc, relay };
}

describe("relay", () => {
  it("connects for the first viewer and sends labeled, anonymized messages", async () => {
    const { irc, relay } = await setup();
    const client = viewer();
    relay.subscribe(client);
    expect(client.hello?.status.state).toBe("connecting");
    await waitFor(() => relay.state === "live");

    irc.say("alpha", "RealName", "is this the final boss?");
    irc.say("alpha", "Troll", "you are vile garbage");
    irc.say("alpha", "Spammer", "cheap viewers at growfast.shop/now @SomeStreamer");
    await waitFor(() => client.messages.length === 3);

    const [question, hidden, spam] = client.messages as [FeedEntry, FeedEntry, FeedEntry];
    expect(question).toMatchObject({ text: "is this the final boss?", label: "question", p: 0.9, cached: false });
    expect(question.user).toMatch(/^viewer-\d{4}$/);
    expect(JSON.stringify(client.messages)).not.toMatch(/RealName|Troll|Spammer|SomeStreamer|growfast/);
    expect(hidden).toMatchObject({ text: null, label: "hateful", p: 0.97 });
    expect(spam.text).toBe("cheap viewers at [link] @viewer");

    const status = relay.status();
    expect(status).toMatchObject({ state: "live", stream: { channel: "alpha" }, watching: 1, model: "jev-mock" });
    expect(status.today).toMatchObject({ judged: 3, inputTokens: 300 });
  });

  it("sends newcomers the recent messages, and shows a copy-paste flood once", async () => {
    const { irc, relay } = await setup();
    const first = viewer();
    relay.subscribe(first);
    await waitFor(() => relay.state === "live");
    irc.say("alpha", "a", "LETS GO");
    await waitFor(() => first.messages.length === 1);
    irc.say("alpha", "b", "lets   go");
    irc.say("alpha", "c", "hello chat");
    await waitFor(() => first.messages.length === 2);
    expect(first.messages.map((m) => m.text)).toEqual(["LETS GO", "hello chat"]);

    const second = viewer();
    relay.subscribe(second);
    expect(second.hello?.recent.map((m) => m.text)).toEqual(["LETS GO", "hello chat"]);
  });

  it("leaves Twitch after the last viewer has been gone for a while", async () => {
    const { irc, relay } = await setup({ idleDisconnectMs: 50 });
    const leave = relay.subscribe(viewer());
    await waitFor(() => relay.state === "live" && irc.isOpen("alpha"));
    leave();
    expect(relay.state).toBe("live");
    await waitFor(() => relay.state === "idle" && !irc.isOpen("alpha"));

    relay.subscribe(viewer());
    await waitFor(() => relay.state === "live");
  });

  it("stops at the daily token budget and says so", async () => {
    const { irc, relay } = await setup({ budget: new DailyBudget(150) });
    const client = viewer();
    relay.subscribe(client);
    await waitFor(() => relay.state === "live");
    irc.say("alpha", "a", "one");
    irc.say("alpha", "b", "two");
    await waitFor(() => relay.state === "budget");
    expect(client.statuses.at(-1)).toMatchObject({ state: "budget", today: { budgetUsed: 1 } });
    await waitFor(() => !irc.isOpen("alpha"));

    const late = viewer();
    relay.subscribe(late);
    expect(late.hello?.status.state).toBe("budget");
  });

  it("moves to another channel when chat goes quiet", async () => {
    const { irc, relay } = await setup({ quietSwitchMs: 100 }, ["alpha", "beta"]);
    relay.subscribe(viewer());
    await waitFor(() => relay.status().stream?.channel === "beta");
    expect(irc.joined.slice(0, 2)).toEqual(["alpha", "beta"]);
  });
});

describe("server", () => {
  it("serves status and an event stream, and checks origins", async () => {
    const { relay } = await setup();
    const server = createRelayServer(relay, { allowedOrigins: ["https://jevevents.dev"] });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const status = await fetch(`${base}/status`);
    expect(await status.json()).toMatchObject({ state: "idle", watching: 0 });
    expect((await fetch(`${base}/status`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);

    const controller = new AbortController();
    const feed = await fetch(`${base}/feed`, { headers: { Origin: "https://jevevents.dev" }, signal: controller.signal });
    expect(feed.headers.get("content-type")).toContain("text/event-stream");
    expect(feed.headers.get("access-control-allow-origin")).toBe("https://jevevents.dev");
    const reader = (feed.body as ReadableStream<Uint8Array>).getReader();
    let received = "";
    while (!received.includes("event: hello")) received += new TextDecoder().decode((await reader.read()).value);
    expect(received).toContain('"recent":[]');
    await waitFor(() => relay.watching === 1);
    controller.abort();
    await waitFor(() => relay.watching === 0);
  });
});

describe("scrub", () => {
  it("masks links and mentions and trims long messages", () => {
    expect(scrub("go to https://example.com/x now")).toBe("go to [link] now");
    expect(scrub("www.site.org rocks")).toBe("[link] rocks");
    expect(scrub("free stuff at csgo-drops.xyz")).toBe("free stuff at [link]");
    expect(scrub("gg @streamer_1")).toBe("gg @viewer");
    expect(scrub("version 1.2 is out, ok.")).toBe("version 1.2 is out, ok.");
    expect(scrub("x".repeat(400))).toHaveLength(280);
  });
});

describe("liveChannels", () => {
  it("prefers a live favorite and skips mature, blocked and busy channels", async () => {
    const calls: string[] = [];
    const picker = liveChannels({
      clientId: "cid",
      clientSecret: "secret",
      preferred: ["favorite"],
      blocked: ["blockedone"],
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("oauth2/token")) return Response.json({ access_token: "app", expires_in: 3600 });
        if (url.includes("user_login=favorite")) return Response.json({ data: [] });
        return Response.json({
          data: [
            { user_login: "Huge", viewer_count: 90_000, game_name: "Chess" },
            { user_login: "Mature", viewer_count: 5_000, is_mature: true },
            { user_login: "BlockedOne", viewer_count: 5_000 },
            { user_login: "Good", viewer_count: 5_000, game_name: "Elden Ring" },
          ],
        });
      },
    });
    expect(await picker.pick(new Set())).toEqual({ channel: "good", viewers: 5_000, game: "Elden Ring" });
    expect(await picker.pick(new Set(["good"]))).toBeUndefined();
    expect(calls.filter((url) => url.includes("oauth2/token"))).toHaveLength(1);
  });
});
