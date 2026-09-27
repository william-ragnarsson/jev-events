import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryStore, monitor, noul, runtime, silentLogger, toConnection, type Connection, type ErrorEvent, type JudgedEvent, type Logger } from "jev-events";
import { mockJev } from "jev-events/testing";
import { app, handleEventsRequest, messages, slackSignature, type EventCallback, type SlackMessageItem } from "@jev-events/slack";

import { ANN, callback, fakeSlack, GENERAL, RANDOM, type FakeMessage, type FakeSlack } from "./fake-slack.js";
import { connectionTo } from "./helpers.js";

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
function signed(body: string, options: { secret?: string; timestamp?: number; url?: string } = {}): Request {
  const timestamp = String(options.timestamp ?? Math.floor(NOW / 1000));
  return new Request(options.url ?? URL, {
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

describe("slack.messages() through runtime().handle()", () => {
  let slack: FakeSlack;

  beforeEach(async () => {
    slack = await fakeSlack();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await slack.close();
  });

  const needsAnswer = noul("Does this message need an answer from the team?");

  /** A web app's runtime for the fake workspace, connected without an app-level token as `/connect/slack` saves it. */
  function webApp(options: { signingSecret?: string; source?: ReturnType<typeof messages>; connection?: Connection } = {}) {
    const judged: SlackMessageItem[] = [];
    const errors: ErrorEvent[] = [];
    const warnings: string[] = [];
    const log: Logger = { ...quiet, warn: (line) => void warnings.push(line), error: (line) => void warnings.push(line) };
    const team = monitor({ source: options.source ?? messages(), questions: { needsAnswer }, client: mockJev(() => ({ needsAnswer: 0.2 })), log })
      .on("judged", (e: JudgedEvent<SlackMessageItem>) => void judged.push(e.item))
      .on("error", (e) => void errors.push(e));
    const jev = runtime({
      monitors: [team],
      store: memoryStore(),
      connections: [options.connection ?? connectionTo(slack, { appToken: false })],
      apps: [app(options.signingSecret === undefined ? { signingSecret: SECRET } : options.signingSecret ? { signingSecret: options.signingSecret } : {})],
      log: silentLogger,
    });
    return { jev, judged, errors, warnings };
  }

  /** What Slack sends to the Request URL when someone says something, signed now, since the runtime uses the real clock. */
  function event(message: FakeMessage, options: { id?: string; team?: string } = {}): Request {
    const said = slack.post({ ...message, live: false });
    return signedNow(callback({ ...said, event_ts: said.ts }, options.id ?? "Ev1", options.team));
  }

  const signedNow = (payload: object) =>
    signed(JSON.stringify(payload), { timestamp: Math.floor(Date.now() / 1000), url: "https://example.com/api/jev/webhook/slack" });

  it("judges messages Slack sends to /webhook/slack, with no Socket Mode connection", async () => {
    const { jev, judged, errors } = webApp();
    const response = await jev.handle(event({ channel: GENERAL, text: "Is prod down?" }));

    expect(response.status).toBe(200);
    expect(judged).toMatchObject([{ text: "Is prod down?", author: { id: ANN, name: "Ann Smith" }, channel: { id: GENERAL, name: "general" } }]);
    expect(errors).toEqual([]);
    expect(slack.calls("apps.connections.open")).toEqual([]);
    expect(slack.calls("auth.test")).toEqual([]);
  });

  it("answers Slack's check of the Request URL", async () => {
    const { jev } = webApp();
    const response = await jev.handle(signedNow({ type: "url_verification", challenge: "abc" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "abc" });
  });

  it("judges a message once when Slack sends it again", async () => {
    const { jev, judged } = webApp();
    const first = event({ channel: GENERAL, text: "Is prod down?" });
    const again = first.clone();

    await jev.handle(first);
    await jev.handle(again);

    expect(judged.map((item) => item.text)).toEqual(["Is prod down?"]);
  });

  it("reads only the channels it was given", async () => {
    const { jev, judged } = webApp({ source: messages({ channels: ["random"] }) });
    await jev.handle(event({ channel: GENERAL, text: "Is prod down?" }, { id: "Ev1" }));
    await jev.handle(event({ channel: RANDOM, text: "Lunch?" }, { id: "Ev2" }));

    expect(judged.map((item) => item.text)).toEqual(["Lunch?"]);
  });

  it("warns once about events from a workspace that isn't connected", async () => {
    const { jev, judged, warnings } = webApp();
    await jev.handle(event({ channel: GENERAL, text: "Is prod down?" }, { id: "Ev1", team: "T0OTHER" }));
    await jev.handle(event({ channel: GENERAL, text: "Anyone?" }, { id: "Ev2", team: "T0OTHER" }));

    expect(judged).toEqual([]);
    expect(warnings).toEqual(["slack: an event came in from workspace T0OTHER, which isn't connected. Connect it with /connect/slack."]);
  });

  it("refuses requests that Slack didn't sign", async () => {
    const { jev, judged } = webApp({ signingSecret: "another-secret" });
    const response = await jev.handle(event({ channel: GENERAL, text: "Is prod down?" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid signature. Check the signing secret." });
    expect(judged).toEqual([]);
  });

  it("says it needs the signing secret", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "");
    const { jev, warnings } = webApp({ signingSecret: "" });
    const response = await jev.handle(event({ channel: GENERAL, text: "Is prod down?" }));
    const message =
      "Slack's Events API needs your app's signing secret, from Basic Information → App Credentials: set SLACK_SIGNING_SECRET, or pass runtime({ apps: [slack.app({ signingSecret })] }).";

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: message });
    expect(warnings).toEqual([message]);
  });

  it("takes the signing secret from SLACK_SIGNING_SECRET", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    const { jev, judged } = webApp({ signingSecret: "" });
    const response = await jev.handle(event({ channel: GENERAL, text: "Is prod down?" }));

    expect(response.status).toBe(200);
    expect(judged).toHaveLength(1);
  });

  it("asks Slack to send an event again when reading it failed, and judges it once", async () => {
    // Without account facts, the session asks Slack who the app is.
    const { facts: _facts, ...bare } = slack.connection({ appToken: false });
    slack.fail("auth.test", "internal_error");
    const { jev, judged, errors } = webApp({ connection: toConnection("slack", bare) });
    const request = event({ channel: GENERAL, text: "Is prod down?" });
    const again = request.clone();

    const failed = await jev.handle(request);
    const retried = await jev.handle(again);

    expect(failed.status).toBe(500);
    expect(errors).toMatchObject([{ phase: "source", connection: { label: "Acme" }, error: { message: "Slack auth.test failed: internal_error." } }]);
    expect(retried.status).toBe(200);
    expect(judged.map((item) => item.text)).toEqual(["Is prod down?"]);
  });

  it("marks the workspace as needing a new sign-in when Slack signed the app out", async () => {
    slack.revoke();
    const { jev, judged, errors } = webApp();
    const response = await jev.handle(event({ channel: GENERAL, text: "Is prod down?" }));
    const saved = await jev.store.connections.list({ integration: "slack" });

    // Sending it again won't help until someone connects the workspace again.
    expect(response.status).toBe(200);
    expect(judged).toEqual([]);
    expect(errors).toMatchObject([{ needsSignIn: true, fatal: true, connection: { label: "Acme" } }]);
    expect(saved).toMatchObject([
      { status: "needs-sign-in", problem: "Slack signed this workspace out (token_revoked): the token was revoked or isn't valid." },
    ]);
  });

  it("reports a missing scope without asking Slack to send the event again", async () => {
    slack.removeScope("users:read");
    const { jev, judged, errors } = webApp();
    const response = await jev.handle(event({ channel: GENERAL, text: "Is prod down?" }));

    expect(response.status).toBe(200);
    expect(judged).toEqual([]);
    expect(errors).toMatchObject([{ error: { message: expect.stringContaining("the app lacks the users:read scope") } }]);
  });
});
