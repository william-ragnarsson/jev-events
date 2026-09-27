import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import { monitor, noul, silentLogger, type ErrorEvent, type JudgedEvent } from "../src/index.js";
import { bluesky, twitchChat, type BlueskyPostItem, type TwitchChatItem } from "../src/public/index.js";
import { mockJev } from "../src/testing.js";

// The public sources against local fakes of Twitch's chat server and Bluesky's Jetstream, so these
// run offline. `npm run test:smoke` runs the same sources against the real services.

const question = noul("Is this worth a look?");
const client = mockJev(() => ({ question: 0.1 }));

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function fakeServer(onConnection: (socket: ServerSocket, url: string) => void) {
  const server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const sockets: ServerSocket[] = [];
  server.on("connection", (socket, request) => {
    sockets.push(socket);
    onConnection(socket, request.url ?? "");
  });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of server.clients) socket.terminate();
        server.close(() => resolve());
      }),
  );
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, sockets };
}

const waitFor = async (condition: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

// ---------------------------------------------------------------------------
// Twitch chat, read anonymously over IRC
// ---------------------------------------------------------------------------

/** A fake Twitch chat server. Records every line the client sends and answers JOIN like Twitch does. */
async function fakeTwitchIrc(onJoin?: (channel: string, socket: ServerSocket) => void) {
  const received: string[] = [];
  const server = await fakeServer((socket) => {
    socket.on("message", (data) => {
      for (const line of String(data).split("\r\n").filter(Boolean)) {
        received.push(line);
        const join = /^JOIN #(\w+)/.exec(line)?.[1];
        if (!join) continue;
        if (onJoin) onJoin(join, socket);
        else socket.send(`@room-id=1234 :tmi.twitch.tv ROOMSTATE #${join}\r\n`);
      }
    });
  });
  return { ...server, received };
}

let sequence = 0;
function privmsg(login: string, text: string, tags: Record<string, string> = {}): string {
  const all = {
    id: `msg-${++sequence}`,
    "room-id": "1234",
    "user-id": `${login}-id`,
    "display-name": login,
    "tmi-sent-ts": String(Date.now()),
    ...tags,
  };
  const encoded = Object.entries(all)
    .map(([key, value]) => `${key}=${value}`)
    .join(";");
  return `@${encoded} :${login}!${login}@${login}.tmi.twitch.tv PRIVMSG #somechannel :${text}\r\n`;
}

describe("twitchChat (anonymous)", () => {
  it("joins without an account, answers PING, and turns chat into items", async () => {
    const irc = await fakeTwitchIrc();
    const judged: Array<JudgedEvent<TwitchChatItem>> = [];
    const chat = monitor({ source: twitchChat("#SomeChannel", { endpoint: irc.url }), questions: { question }, client, log: silentLogger }).on(
      "judged",
      (event) => {
        judged.push(event);
      },
    );

    await chat.start();
    expect(irc.received.slice(0, 4)).toEqual([
      "CAP REQ :twitch.tv/tags twitch.tv/commands",
      "PASS SCHMOOPIIE",
      expect.stringMatching(/^NICK justinfan\d{5}$/),
      "JOIN #somechannel",
    ]);

    const socket = irc.sockets[0] as ServerSocket;
    socket.send("PING :tmi.twitch.tv\r\n");
    await waitFor(() => irc.received.includes("PONG :tmi.twitch.tv"));

    // Several lines in one frame, the way Twitch batches them.
    socket.send(
      privmsg("viewer", "what game is this?", { "first-msg": "1" }) +
        privmsg("viewer", "!uptime") +
        privmsg("nightbot", "Follow the channel!") +
        privmsg("amod", "calm down chat", { badges: "moderator/1" }),
    );
    await waitFor(() => judged.length === 2);
    await chat.stop();

    const [first, second] = judged;
    expect(first?.item).toMatchObject({
      text: "what game is this?",
      channel: "somechannel",
      channelId: "1234",
      firstMessage: true,
      author: { name: "viewer", login: "viewer", roles: [] },
      facts: { firstMessage: true },
    });
    expect(first?.protected).toBe(false);
    // Commands and known bots are skipped before they cost anything; moderators are judged but protected.
    expect(second?.item).toMatchObject({ text: "calm down chat", author: { roles: ["moderator"] } });
    expect(second?.protected).toBe(true);
  });

  it("reconnects and rejoins when Twitch asks it to", async () => {
    const irc = await fakeTwitchIrc();
    const texts: string[] = [];
    const chat = monitor({ source: twitchChat("somechannel", { endpoint: irc.url }), questions: { question }, client, log: silentLogger }).on(
      "judged",
      (event) => {
        texts.push(event.item.text);
      },
    );
    await chat.start();

    (irc.sockets[0] as ServerSocket).send(":tmi.twitch.tv RECONNECT\r\n");
    await waitFor(() => irc.received.filter((line) => line === "JOIN #somechannel").length === 2, 5000);
    (irc.sockets[1] as ServerSocket).send(privmsg("viewer", "back again"));
    await waitFor(() => texts.includes("back again"));
    await chat.stop();
  }, 10_000);

  it("reports a channel that is suspended or doesn't exist", async () => {
    const irc = await fakeTwitchIrc((channel, socket) =>
      socket.send(`@msg-id=msg_channel_suspended :tmi.twitch.tv NOTICE #${channel} :This channel does not exist or has been suspended.\r\n`),
    );
    const errors: ErrorEvent[] = [];
    const chat = monitor({ source: twitchChat("gonechannel", { endpoint: irc.url }), questions: { question }, client, log: silentLogger }).on(
      "error",
      (event) => {
        errors.push(event);
      },
    );

    await expect(chat.start()).rejects.toThrow();
    expect(errors.map((event) => [event.phase, (event.error as Error).message])).toEqual([
      ["source", "#gonechannel is suspended or doesn't exist."],
    ]);
  });

  it("rejects names that can't be Twitch channels", () => {
    expect(() => twitchChat("not a channel!")).toThrow(/not a valid Twitch channel name/);
  });
});

// ---------------------------------------------------------------------------
// Bluesky, from the Jetstream firehose
// ---------------------------------------------------------------------------

let time = 1_727_000_000_000_000;
function post(did: string, rkey: string, text: string, record: Record<string, unknown> = {}) {
  return {
    did,
    time_us: ++time,
    kind: "commit",
    commit: {
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey,
      record: { text, langs: ["en"], createdAt: "2026-09-25T10:00:00.000Z", ...record },
    },
  };
}

/** A fake Jetstream that sends `events` to the first connection only, and records every connection URL. */
async function fakeJetstream(events: unknown[]) {
  const urls: string[] = [];
  const server = await fakeServer((socket, url) => {
    urls.push(url);
    if (urls.length === 1) for (const event of events) socket.send(JSON.stringify(event));
    else socket.send(JSON.stringify({ did: "did:plc:x", time_us: ++time, kind: "identity" }));
  });
  return { ...server, urls };
}

describe("bluesky", () => {
  it("streams new posts, keeping only the languages and keywords you asked for", async () => {
    const events = [
      { did: "did:plc:someone", time_us: ++time, kind: "identity" },
      post("did:plc:alice1234567", "r1", "Loving TypeScript today"),
      post("did:plc:bob", "r2", "TypeScript は最高", { langs: ["ja"] }),
      post("did:plc:carol", "r3", "Coffee first"),
      { did: "did:plc:alice1234567", time_us: ++time, kind: "commit", commit: { operation: "delete", collection: "app.bsky.feed.post", rkey: "r1" } },
      post("did:plc:dave", "r4", "Quick typescript question: why?", { reply: { root: {}, parent: {} } }),
    ];
    const jetstream = await fakeJetstream(events);
    const judged: Array<JudgedEvent<BlueskyPostItem>> = [];
    const posts = monitor({
      source: bluesky({ keywords: ["TypeScript"], langs: ["en"], endpoint: jetstream.url }),
      questions: { question },
      client,
      log: silentLogger,
    }).on("judged", (event) => {
      judged.push(event);
    });

    await posts.start();
    await waitFor(() => judged.length === 2);
    await posts.stop();

    expect(new URL(jetstream.urls[0] ?? "", "ws://x").searchParams.get("wantedCollections")).toBe("app.bsky.feed.post");
    expect(judged.map((event) => event.item)).toEqual([
      expect.objectContaining({
        id: "did:plc:alice1234567/r1",
        text: "Loving TypeScript today",
        author: { id: "did:plc:alice1234567", name: "alice12345" },
        uri: "at://did:plc:alice1234567/app.bsky.feed.post/r1",
        url: "https://bsky.app/profile/did:plc:alice1234567/post/r1",
        langs: ["en"],
        at: new Date("2026-09-25T10:00:00.000Z"),
      }),
      expect.objectContaining({ id: "did:plc:dave/r4", facts: { isReply: true } }),
    ]);
  });

  it("resumes from the last event it saw after a disconnect", async () => {
    const events = [post("did:plc:alice", "r1", "first"), post("did:plc:alice", "r2", "second")];
    const jetstream = await fakeJetstream(events);
    const posts = monitor({ source: bluesky({ endpoint: jetstream.url }), questions: { question }, client, log: silentLogger });

    await posts.start();
    (jetstream.sockets[0] as ServerSocket).close();
    await waitFor(() => jetstream.urls.length === 2, 5000);
    await posts.stop();

    expect(new URL(jetstream.urls[0] ?? "", "ws://x").searchParams.get("cursor")).toBeNull();
    expect(new URL(jetstream.urls[1] ?? "", "ws://x").searchParams.get("cursor")).toBe(String(time - 1));
  }, 10_000);
});
