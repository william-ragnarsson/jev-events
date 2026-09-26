import { afterEach, describe, expect, it, vi } from "vitest";

import type { Action, TriggeredEvent } from "jev-events";
import type { TwitchChatItem } from "jev-events/public";

import { Helix, twitch, withTokens, type TwitchChatSource } from "@jev-events/twitch";

// Every native Twitch action against a stubbed Helix API: the request it sends, and how failures
// surface. How the listener gates actions (dry-run, protected chatters) is in twitch.test.ts.

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

/** Stub fetch for Helix and Twitch's OAuth endpoints. `respond` defaults to 204 No Content. */
function stubTwitch(respond: (call: Call) => Response | undefined = () => undefined) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : init.body;
    const call: Call = { method: init.method ?? "GET", url: new URL(String(input)), headers: new Headers(init.headers), body };
    calls.push(call);
    return respond(call) ?? new Response(null, { status: 204 });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function signedInSource(auth = withTokens({ clientId: "cid", accessToken: "token" })): TwitchChatSource {
  return {
    id: "twitch:chat:mychannel",
    platform: "twitch",
    channel: "mychannel",
    session: { helix: new Helix(auth), broadcasterId: "1000", botId: "999", botLogin: "jevbot" },
    start: () => Promise.resolve(),
  };
}

const event: TriggeredEvent<TwitchChatItem> = {
  item: {
    id: "msg-1",
    text: "you idiot",
    author: { id: "42", name: "Viewer", login: "viewer", roles: [] },
    at: new Date(),
    channel: "mychannel",
    firstMessage: false,
  },
  answers: {},
  model: "jev-test",
  latencyMs: 12,
  usage: { inputTokens: 100, outputTokens: 0 },
  cached: false,
  dryRun: false,
  protected: false,
  trigger: { event: "hateful", question: "hateful", probability: 0.93 },
};

const moderation = { broadcaster_id: "1000", moderator_id: "999" };

const cases: Array<{
  action: Action<"twitch", TwitchChatItem>;
  describes: string;
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}> = [
  {
    action: twitch.timeout({ seconds: 60 }),
    describes: "timeout Viewer for 60s",
    method: "POST",
    path: "/helix/moderation/bans",
    query: moderation,
    body: { data: { user_id: "42", duration: 60, reason: "jev-events: hateful (93%)" } },
  },
  {
    action: twitch.timeout(),
    describes: "timeout Viewer for 600s",
    method: "POST",
    path: "/helix/moderation/bans",
    query: moderation,
    body: { data: { user_id: "42", duration: 600, reason: "jev-events: hateful (93%)" } },
  },
  {
    action: twitch.ban(),
    describes: "ban Viewer",
    method: "POST",
    path: "/helix/moderation/bans",
    query: moderation,
    body: { data: { user_id: "42", reason: "jev-events: hateful (93%)" } },
  },
  {
    action: twitch.deleteMessage(),
    describes: "delete the message from Viewer",
    method: "DELETE",
    path: "/helix/moderation/chat",
    query: { ...moderation, message_id: "msg-1" },
  },
  {
    action: twitch.warn({ reason: "Keep it civil" }),
    describes: "warn Viewer",
    method: "POST",
    path: "/helix/moderation/warnings",
    query: moderation,
    body: { data: { user_id: "42", reason: "Keep it civil" } },
  },
  {
    action: twitch.reply((e) => `@${e.item.author.name} please keep it civil`),
    describes: 'reply to Viewer: "@Viewer please keep it civil"',
    method: "POST",
    path: "/helix/chat/messages",
    query: {},
    body: { broadcaster_id: "1000", sender_id: "999", message: "@Viewer please keep it civil", reply_parent_message_id: "msg-1" },
  },
  {
    action: twitch.say("Chat is on fire"),
    describes: 'say "Chat is on fire"',
    method: "POST",
    path: "/helix/chat/messages",
    query: {},
    body: { broadcaster_id: "1000", sender_id: "999", message: "Chat is on fire" },
  },
  {
    action: twitch.clip(),
    describes: "create a clip",
    method: "POST",
    path: "/helix/clips",
    query: { broadcaster_id: "1000" },
  },
];

describe("twitch actions", () => {
  it.each(cases)("$action.name sends $method $path", async ({ action, describes, method, path, query, body }) => {
    const calls = stubTwitch();
    expect(action.platform).toBe("twitch");
    expect(action.describe(event)).toBe(describes);

    await action.run(event, signedInSource());

    expect(calls).toHaveLength(1);
    const [call] = calls as [Call];
    expect(call.method).toBe(method);
    expect(`${call.url.origin}${call.url.pathname}`).toBe(`https://api.twitch.tv${path}`);
    expect(Object.fromEntries(call.url.searchParams)).toEqual(query);
    expect(call.body).toEqual(body);
    expect(call.headers.get("Client-Id")).toBe("cid");
    expect(call.headers.get("Authorization")).toBe("Bearer token");
    expect(call.headers.get("Content-Type")).toBe(body === undefined ? null : "application/json");
  });

  it("takes the reason from a function of the event", async () => {
    const calls = stubTwitch();
    await twitch.ban({ reason: (e) => `${e.trigger.event} in ${e.item.channel}` }).run(event, signedInSource());
    expect(calls[0]?.body).toEqual({ data: { user_id: "42", reason: "hateful in mychannel" } });
  });

  it("refreshes an expired token once and retries", async () => {
    const saved: unknown[] = [];
    const calls = stubTwitch((call) => {
      if (call.url.hostname === "id.twitch.tv") {
        return new Response(JSON.stringify({ access_token: "fresh", refresh_token: "fresh-refresh", expires_in: 14_000 }));
      }
      if (call.headers.get("Authorization") === "Bearer stale") return new Response(JSON.stringify({ message: "Invalid OAuth token" }), { status: 401 });
      return undefined;
    });
    const auth = withTokens({ clientId: "cid", accessToken: "stale", refreshToken: "refresh" }, (tokens) => saved.push(tokens));

    await twitch.deleteMessage().run(event, signedInSource(auth));

    expect(calls.map((call) => `${call.method} ${call.url.hostname}${call.url.pathname}`)).toEqual([
      "DELETE api.twitch.tv/helix/moderation/chat",
      "POST id.twitch.tv/oauth2/token",
      "DELETE api.twitch.tv/helix/moderation/chat",
    ]);
    expect(calls[2]?.headers.get("Authorization")).toBe("Bearer fresh");
    expect(saved).toEqual([expect.objectContaining({ accessToken: "fresh", refreshToken: "fresh-refresh" })]);
  });

  it("surfaces Twitch's own error message", async () => {
    stubTwitch(() =>
      new Response(JSON.stringify({ error: "Bad Request", status: 400, message: "The user specified in the user_id field may not be banned." }), {
        status: 400,
      }),
    );
    const failure = twitch.timeout().run(event, signedInSource());
    await expect(failure).rejects.toMatchObject({ name: "TwitchApiError", status: 400 });
    await expect(failure).rejects.toThrow(
      "Twitch POST /moderation/bans failed (400): The user specified in the user_id field may not be banned.",
    );
  });

  it("needs a signed-in source", async () => {
    const calls = stubTwitch();
    const anonymous = twitch.chat("mychannel");
    await expect(twitch.timeout().run(event, anonymous)).rejects.toThrow("Twitch actions need a signed-in source");
    expect(calls).toHaveLength(0);
  });
});
