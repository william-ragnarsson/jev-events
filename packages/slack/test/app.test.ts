import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryStore, monitor, noul, runtime, silentLogger, type ErrorEvent, type JudgedEvent, type Runtime } from "jev-events";
import { mockJev } from "jev-events/testing";
import { app, BOT_SCOPES, messages, slackSignature, type SlackMessageItem } from "@jev-events/slack";

import { BOT, BOT_TOKEN, CLIENT, fakeSlack, GENERAL, TEAM, type FakeSlack } from "./fake-slack.js";
import { waitFor } from "./helpers.js";

const BASE = "https://example.com/api/jev";
const REDIRECT = `${BASE}/callback/slack`;

let slack: FakeSlack;

beforeEach(async () => {
  slack = await fakeSlack();
  for (const name of ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET", "SLACK_APP_TOKEN"]) vi.stubEnv(name, undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await slack.close();
});

const needsAnswer = noul("Does this message need an answer from the team?");

/** A site that lets people add the Slack app to their workspace, as in the Next.js guide. */
function site(options: { app?: ReturnType<typeof app> } = {}) {
  const judged: Array<JudgedEvent<SlackMessageItem>> = [];
  const errors: ErrorEvent[] = [];
  const team = monitor({ source: messages(), questions: { needsAnswer }, client: mockJev(() => ({ needsAnswer: 0.9 })), log: silentLogger })
    .on("judged", (e) => void judged.push(e))
    .on("error", (e) => void errors.push(e));
  const jev = runtime({
    monitors: [team],
    store: memoryStore(),
    apps: [options.app ?? app({ clientId: CLIENT.id, clientSecret: CLIENT.secret, signingSecret: "signing-secret" })],
    baseUrl: BASE,
    log: silentLogger,
  });
  return { jev, judged, errors };
}

/** What the page the callback answers with says, as text. */
async function pageText(response: Response): Promise<string> {
  const html = await response.text();
  const main = /<main>([\s\S]*)<\/main>/.exec(html)?.[1] ?? html;
  return main
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

/** Click Allow on Slack's consent page: Slack sends the browser back to the callback with a code. */
async function allow(jev: Runtime, consent: URL, code = slack.code(consent.searchParams.get("redirect_uri") ?? undefined)) {
  return jev.handle(new Request(`${REDIRECT}?code=${code}&state=${consent.searchParams.get("state")}`));
}

describe("slack.app() sign-in", () => {
  it("sends people to Slack's consent page with the scopes the source and actions need", async () => {
    const { jev } = site();

    const consent = new URL(await jev.connectUrl("slack", { scopes: ["reactions:read"] }));

    expect(`${consent.origin}${consent.pathname}`).toBe(`${slack.url}/oauth/v2/authorize`);
    expect(Object.fromEntries(consent.searchParams)).toEqual({
      client_id: CLIENT.id,
      scope: [...BOT_SCOPES, "reactions:read"].join(","),
      redirect_uri: REDIRECT,
      state: expect.any(String),
    });
  });

  it("saves the workspace when someone clicks Allow, with who the app is there", async () => {
    const { jev } = site();
    const consent = new URL(await jev.connectUrl("slack", { userId: "u1", returnTo: "/settings" }));

    const done = await allow(jev, consent);

    expect([done.status, done.headers.get("location")]).toEqual([302, "/settings?connected=slack"]);
    expect(await jev.store.connections.list()).toEqual([
      expect.objectContaining({
        id: "slack:u1:T0ACME",
        integration: "slack",
        userId: "u1",
        label: "Acme",
        credentials: { token: BOT_TOKEN },
        facts: { team: "Acme", teamId: TEAM.id, userId: BOT.userId, user: BOT.handle, url: TEAM.url, botId: BOT.botId, appId: BOT.appId },
        status: "active",
      }),
    ]);
    expect(slack.calls("oauth.v2.access").map((call) => call.params)).toEqual([
      { client_id: CLIENT.id, client_secret: CLIENT.secret, code: expect.any(String), redirect_uri: REDIRECT },
    ]);
  });

  it("judges the new workspace's messages through /webhook/slack once it's connected", async () => {
    const { jev, judged } = site();
    await allow(jev, new URL(await jev.connectUrl("slack")));
    const said = slack.post({ channel: GENERAL, text: "Is prod down?", live: false });
    const body = JSON.stringify({ type: "event_callback", team_id: TEAM.id, event_id: "Ev1", event: { ...said, event_ts: said.ts } });
    const timestamp = String(Math.floor(Date.now() / 1000));

    const response = await jev.handle(
      new Request(`${BASE}/webhook/slack`, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": slackSignature("signing-secret", timestamp, body),
        },
      }),
    );
    await waitFor(() => judged.length === 1);

    expect(response.status).toBe(200);
    expect(judged[0]?.item.text).toBe("Is prod down?");
    expect(judged[0]?.connection).toMatchObject({ id: "slack:T0ACME", label: "Acme" });
  });

  it("reads the client ID and secret from SLACK_CLIENT_ID and SLACK_CLIENT_SECRET", async () => {
    vi.stubEnv("SLACK_CLIENT_ID", CLIENT.id);
    vi.stubEnv("SLACK_CLIENT_SECRET", CLIENT.secret);
    const { jev } = site({ app: app() });

    const done = await allow(jev, new URL(await jev.connectUrl("slack")));

    expect(done.status).toBe(200);
    expect(await pageText(done)).toBe("Connected Acme. You can close this tab. Jev Events");
  });

  it("says where to find the client ID and secret when they're missing", async () => {
    const { jev } = site({ app: app() });

    await expect(jev.connectUrl("slack")).rejects.toThrow(
      "Slack needs your app's credentials: set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET, or pass slack.app({ clientId, clientSecret }). They're under Basic Information → App Credentials at https://api.slack.com/apps",
    );
  });

  it.each([
    [
      "a wrong client secret",
      () => ({ app: app({ clientId: CLIENT.id, clientSecret: "wrong" }) }),
      "Slack refused the sign-in: the client ID or secret is wrong. Check SLACK_CLIENT_ID and SLACK_CLIENT_SECRET (Basic Information → App Credentials).",
    ],
    [
      "a code that was already used",
      () => ({ code: "code-used" }),
      "Slack refused the sign-in: the code expired or was already used. Try connecting again.",
    ],
    [
      "a redirect URL Slack doesn't know",
      () => ({ code: slack.code("https://elsewhere.example/callback/slack") }),
      `Slack refused the sign-in: add ${REDIRECT} under OAuth & Permissions → Redirect URLs.`,
    ],
  ])("says what to fix, given %s", async (_, setup, message) => {
    const options = setup() as { app?: ReturnType<typeof app>; code?: string };
    const { jev } = site(options.app ? { app: options.app } : {});
    const consent = new URL(await jev.connectUrl("slack"));

    const done = options.code === undefined ? await allow(jev, consent) : await allow(jev, consent, options.code);

    expect(done.status).toBe(502);
    expect(await pageText(done)).toBe(`Couldn't finish signing in: ${message} Jev Events`);
    expect(await jev.store.connections.list()).toEqual([]);
  });
});
