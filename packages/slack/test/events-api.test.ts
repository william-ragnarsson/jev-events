import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Logger } from "jev-events";
import { handleEventsRequest, messages, slackSignature, withTokens, type EventCallback } from "@jev-events/slack";

import { ANN, APP_TOKEN, BOT_TOKEN, fakeSlack, GENERAL, type FakeSlack } from "./fake-slack.js";
import { startSource, waitFor } from "./helpers.js";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const NOW = 1_760_000_000_000;
const URL = "https://example.com/api/slack";

const message: EventCallback = {
  type: "event_callback",
  team_id: "T0ACME",
  event_id: "Ev1",
  event_time: 1_760_000_000,
  event: { type: "message", channel: GENERAL, channel_type: "channel", user: ANN, text: "Is prod down?", ts: "1760000000.000100" },
};

/** A request as Slack signs it. */
function signed(body: string, options: { secret?: string; timestamp?: number } = {}): Request {
  const timestamp = String(options.timestamp ?? Math.floor(NOW / 1000));
  return new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": slackSignature(options.secret ?? SECRET, timestamp, body) },
    body,
  });
}

function handle(request: Request, deliver?: (payload: EventCallback) => void, log: Logger = quiet) {
  return handleEventsRequest(request, { signingSecret: SECRET, deliver, log, now: () => NOW });
}

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe("slackSignature", () => {
  it("signs the way Slack's docs show", () => {
    const body =
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";

    expect(slackSignature(SECRET, 1531420618, body)).toBe("v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503");
  });
});

describe("handleEventsRequest", () => {
  it("answers Slack's check of the URL", async () => {
    const response = await handle(signed(JSON.stringify({ type: "url_verification", token: "legacy", challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" })));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" });
  });

  it("hands events on and answers at once", async () => {
    const delivered: EventCallback[] = [];
    const response = await handle(signed(JSON.stringify(message)), (payload) => void delivered.push(payload));

    expect(response.status).toBe(200);
    expect(delivered).toEqual([message]);
  });

  it.each([
    ["signed with another secret", () => signed(JSON.stringify(message), { secret: "not-the-secret" }), 401, "Invalid signature. Check the signing secret."],
    [
      "changed after signing",
      () => {
        const original = signed(JSON.stringify(message));
        return new Request(URL, { method: "POST", headers: original.headers, body: JSON.stringify({ ...message, event_id: "Ev2" }) });
      },
      401,
      "Invalid signature. Check the signing secret.",
    ],
    ["older than five minutes", () => signed(JSON.stringify(message), { timestamp: NOW / 1000 - 301 }), 401, "Missing or stale X-Slack-Request-Timestamp."],
    ["from the future", () => signed(JSON.stringify(message), { timestamp: NOW / 1000 + 301 }), 401, "Missing or stale X-Slack-Request-Timestamp."],
    ["without a timestamp", () => new Request(URL, { method: "POST", body: JSON.stringify(message) }), 401, "Missing or stale X-Slack-Request-Timestamp."],
    ["not a POST", () => new Request(URL), 405, "Slack sends events with POST."],
  ])("refuses a request %s", async (_, request, status, error) => {
    const delivered: EventCallback[] = [];
    const response = await handle(request(), (payload) => void delivered.push(payload));

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(delivered).toEqual([]);
  });

  it("says when the body isn't JSON", async () => {
    const response = await handle(signed("{not json"), () => {});

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON." });
  });

  it("asks Slack to send events again later while nothing is listening", async () => {
    const response = await handle(signed(JSON.stringify(message)));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Not started yet." });
  });

  it("warns when Slack rate limits the app's events", async () => {
    const warnings: string[] = [];
    const log: Logger = { ...quiet, warn: (line) => void warnings.push(line) };
    const response = await handle(signed(JSON.stringify({ type: "app_rate_limited", team_id: "T0ACME", minute_rate_limited: 1_760_000_000 })), () => {}, log);

    expect(response.status).toBe(200);
    expect(warnings).toEqual(["slack: Slack is dropping events because the app gets more than 30,000 an hour."]);
  });
});

describe("the messages source with the Events API", () => {
  let slack: FakeSlack;

  beforeEach(async () => {
    slack = await fakeSlack();
  });

  afterEach(async () => {
    await slack.close();
  });

  /** Signed now, since source.handle uses the real clock. */
  const signedNow = (payload: object) => signed(JSON.stringify(payload), { timestamp: Math.floor(Date.now() / 1000) });

  it("receives messages from requests you pass to handle(), with no Socket Mode connection", async () => {
    const source = messages({ auth: withTokens({ token: BOT_TOKEN, signingSecret: SECRET }) });
    const check = await source.handle(signedNow({ type: "url_verification", challenge: "abc" }));
    const early = await source.handle(signedNow(message));
    const run = startSource(source);
    await run.started;
    const response = await source.handle(signedNow(message));
    await waitFor(() => run.items.length === 1);
    run.stop();
    const late = await source.handle(signedNow(message));

    expect(check.status).toBe(200);
    expect(await check.json()).toEqual({ challenge: "abc" });
    expect(early.status).toBe(503);
    expect(response.status).toBe(200);
    expect(run.items[0]).toMatchObject({ text: "Is prod down?", author: { name: "Ann Smith" }, channel: { id: GENERAL, name: "general" } });
    expect(slack.calls("apps.connections.open")).toEqual([]);
    expect(late.status).toBe(503);
  });

  it("says it needs the signing secret", async () => {
    const source = messages({ auth: withTokens({ token: BOT_TOKEN, appToken: APP_TOKEN }) });
    const response = await source.handle(signedNow(message));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "No signing secret. Pass it to receive Slack's Events API: slack.auth.withTokens({ token, signingSecret }).",
    });
  });
});
