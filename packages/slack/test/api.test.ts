import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isFatal, SlackApi, SlackApiError, SlackAuthError } from "@jev-events/slack";
import { needsSignIn } from "jev-events";

import { ANN_DM, BOT_TOKEN, fakeSlack, GENERAL, OFF_TOPIC, RANDOM, type FakeSlack } from "./fake-slack.js";

let slack: FakeSlack;

beforeEach(async () => {
  slack = await fakeSlack();
});

afterEach(async () => {
  await slack.close();
});

async function rejection(promise: Promise<unknown>): Promise<SlackApiError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof SlackApiError)) throw new Error(`Expected a SlackApiError, got ${String(error)}`);
  return error;
}

describe("SlackApi", () => {
  it("sends the token and form-encoded arguments, with objects as JSON", async () => {
    const api = new SlackApi(BOT_TOKEN);

    await api.call("chat.postMessage", { channel: GENERAL, text: "Hi", blocks: [{ type: "divider" }], thread_ts: undefined });

    expect(slack.calls("chat.postMessage")).toEqual([
      { method: "chat.postMessage", token: BOT_TOKEN, params: { channel: GENERAL, text: "Hi", blocks: '[{"type":"divider"}]' } },
    ]);
  });

  it("returns Slack's answer", async () => {
    const me = await new SlackApi(BOT_TOKEN).call<{ team: string; user_id: string }>("auth.test");

    expect(me).toMatchObject({ ok: true, team: "Acme", user_id: "U0BOT" });
  });

  it("turns ok: false into an error with Slack's code", async () => {
    const error = await rejection(new SlackApi(BOT_TOKEN).call("users.info", { user: "U0NOBODY" }));

    expect(error.code).toBe("user_not_found");
    expect(error.method).toBe("users.info");
    expect(error.message).toBe("Slack users.info failed: user_not_found.");
    expect(isFatal(error)).toBe(false);
  });

  it("says how to fix the errors people run into", async () => {
    const error = await rejection(new SlackApi(BOT_TOKEN).call("chat.postMessage", { channel: OFF_TOPIC, text: "Hi" }));

    expect(error.message).toBe(
      "Slack chat.postMessage failed: not_in_channel (the app isn't in that channel. In Slack, type /invite @<your app> in it).",
    );
  });

  it("asks for a new sign-in when the token was revoked, and says retrying won't help", async () => {
    slack.revoke();

    const error = await rejection(new SlackApi(BOT_TOKEN).call("auth.test"));

    expect(error.signedOut).toBe(true);
    expect(needsSignIn(error)).toBe(true);
    expect(error.message).toBe("Slack signed this workspace out (token_revoked): the token was revoked or isn't valid.");
    expect(isFatal(error)).toBe(true);
  });

  it("treats a token Slack doesn't know as signed out", async () => {
    const error = await rejection(new SlackApi("xoxb-someone-else").call("auth.test"));

    expect(error.code).toBe("invalid_auth");
    expect(error.signedOut).toBe(true);
  });

  it("names the scope the app lacks", async () => {
    slack.removeScope("reactions:write");

    const error = await rejection(new SlackApi(BOT_TOKEN).call("reactions.add", { channel: ANN_DM, timestamp: "1.000001", name: "eyes" }));

    expect(error.needed).toBe("reactions:write");
    expect(error.message).toBe(
      "Slack reactions.add failed: the app lacks the reactions:write scope. Add it under OAuth & Permissions → Scopes, then reinstall the app to the workspace.",
    );
    expect(isFatal(error)).toBe(true);
    expect(needsSignIn(error)).toBe(false);
  });

  it("retries rate limits as soon as Slack's Retry-After allows", async () => {
    slack.fail("auth.test", "ratelimited", { status: 429, times: 2 });
    const started = Date.now();

    await new SlackApi(BOT_TOKEN).call("auth.test");

    expect(slack.calls("auth.test")).toHaveLength(3);
    // Retry-After: 0, so no waiting, rather than the default backoff of 1s and then 2s.
    expect(Date.now() - started).toBeLessThan(900);
  });

  it("retries when Slack is down, then gives up after three retries", async () => {
    slack.fail("auth.test", "", { status: 503, body: "<html>Service Unavailable</html>", times: 1 });
    await new SlackApi(BOT_TOKEN, { retryBaseMs: 1 }).call("auth.test");
    expect(slack.calls("auth.test")).toHaveLength(2);

    slack.fail("auth.test", "", { status: 502, body: "<html>Bad Gateway</html>", times: 10 });
    const error = await rejection(new SlackApi(BOT_TOKEN, { retryBaseMs: 1 }).call("auth.test"));
    expect(error.code).toBe("http_502");
    expect(slack.calls("auth.test")).toHaveLength(6);
  });

  it("reports a rate limit that doesn't let up", async () => {
    slack.fail("auth.test", "ratelimited", { status: 429, times: 10 });

    const error = await rejection(new SlackApi(BOT_TOKEN).call("auth.test"));

    expect(error.message).toBe("Slack auth.test failed: ratelimited (Slack is rate limiting the app).");
    expect(slack.calls("auth.test")).toHaveLength(4);
  });

  it("collects every page of a list", async () => {
    for (const name of ["design", "eng", "sales"]) slack.addConversation({ id: `C0${name.toUpperCase()}1`, name });

    const channels = await new SlackApi(BOT_TOKEN).list<{ id: string }>("users.conversations", "channels", { types: "public_channel,im" });

    // Two per page in the fake: general, random, the DM with Ann, design, eng and sales.
    expect(channels.map((channel) => channel.id)).toEqual([GENERAL, RANDOM, ANN_DM, "C0DESIGN1", "C0ENG1", "C0SALES1"]);
    const calls = slack.calls("users.conversations");
    expect(calls).toHaveLength(3);
    expect(calls[0]?.params).toEqual({ limit: "200", types: "public_channel,im" });
    expect(calls[1]?.params.cursor).toBeTruthy();
  });

  it("stops listing at max", async () => {
    for (const name of ["design", "eng", "sales"]) slack.addConversation({ id: `C0${name.toUpperCase()}1`, name });

    const channels = await new SlackApi(BOT_TOKEN).list("users.conversations", "channels", { types: "public_channel" }, 3);

    expect(channels).toHaveLength(3);
    expect(slack.calls("users.conversations")).toHaveLength(2);
  });
});

describe("isFatal", () => {
  it("is true for lost or missing credentials and missing scopes, which repeat on every call", () => {
    expect(isFatal(new SlackAuthError("Connect Slack first"))).toBe(true);
    expect(isFatal(new SlackApiError("auth.test", "account_inactive"))).toBe(true);
    expect(isFatal(new SlackApiError("reactions.add", "missing_scope", "reactions:write"))).toBe(true);
    expect(isFatal(new SlackApiError("chat.postMessage", "channel_not_found"))).toBe(false);
    expect(isFatal(new SlackApiError("auth.test", "ratelimited"))).toBe(false);
    expect(isFatal(new Error("ECONNRESET"))).toBe(false);
  });
});
