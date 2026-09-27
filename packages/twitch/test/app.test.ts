import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryStore, monitor, noul, runtime, silentLogger, type ErrorEvent, type JudgedEvent, type Runtime } from "jev-events";
import { mockJev } from "jev-events/testing";
import { app, chat, DEFAULT_SCOPES, type TwitchApp, type TwitchChatItem } from "@jev-events/twitch";

import { ALL_SCOPES, CLIENT, fakeTwitch, STREAMER, type FakeTwitch } from "./fake-twitch.js";
import { waitFor } from "./helpers.js";

// Letting streamers connect their channel on your site: twitch.app() behind /connect/twitch and
// /callback/twitch, and a started runtime reading each channel once it's connected.

const BASE = "https://example.com/api/jev";
const REDIRECT = `${BASE}/callback/twitch`;

let twitch: FakeTwitch;
let sites: Runtime[];

beforeEach(async () => {
  twitch = await fakeTwitch();
  for (const name of ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET", "TWITCH_ACCESS_TOKEN", "TWITCH_REFRESH_TOKEN"]) vi.stubEnv(name, undefined);
  sites = [];
});

afterEach(async () => {
  await Promise.all(sites.map((jev) => jev.stop()));
  vi.unstubAllEnvs();
  await twitch.close();
});

const hateful = noul("Is this chat message hateful?");

/** A site where streamers connect their channel, as in the Next.js guide. */
function site(options: { app?: TwitchApp } = {}) {
  const judged: Array<JudgedEvent<TwitchChatItem>> = [];
  const errors: ErrorEvent[] = [];
  const mod = monitor({ source: chat(), questions: { hateful }, client: mockJev(() => ({ hateful: 0.1 })), log: silentLogger })
    .on("judged", (e) => void judged.push(e))
    .on("error", (e) => void errors.push(e));
  const jev = runtime({
    monitors: [mod],
    store: memoryStore(),
    apps: [options.app ?? app({ clientId: CLIENT.id, clientSecret: CLIENT.secret })],
    baseUrl: BASE,
    log: silentLogger,
  });
  sites.push(jev);
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

/** Click Authorize on Twitch's consent page as the streamer: Twitch sends the browser back to the callback with a code. */
async function authorizeOn(jev: Runtime, consent: URL, code = twitch.code(consent.searchParams.get("redirect_uri") ?? "", STREAMER)) {
  return jev.handle(new Request(`${REDIRECT}?code=${code}&scope=${encodeURIComponent(ALL_SCOPES.join(" "))}&state=${consent.searchParams.get("state")}`));
}

describe("twitch.app() sign-in", () => {
  it("sends people to Twitch's consent page with the scopes chat and the actions need", async () => {
    const { jev } = site();

    const consent = new URL(await jev.connectUrl("twitch", { scopes: ["channel:read:subscriptions"] }));

    expect(`${consent.origin}${consent.pathname}`).toBe(`${twitch.url}/oauth2/authorize`);
    expect(Object.fromEntries(consent.searchParams)).toEqual({
      client_id: CLIENT.id,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: [...DEFAULT_SCOPES, "channel:read:subscriptions"].join(" "),
      state: expect.any(String),
    });
  });

  it("saves the account when the streamer clicks Authorize, and keeps the client secret out of it", async () => {
    const { jev } = site();
    const consent = new URL(await jev.connectUrl("twitch", { userId: "u1", returnTo: "/settings" }));

    const done = await authorizeOn(jev, consent);

    expect([done.status, done.headers.get("location")]).toEqual([302, "/settings?connected=twitch"]);
    expect(await jev.store.connections.list()).toEqual([
      expect.objectContaining({
        id: "twitch:u1:1000",
        integration: "twitch",
        userId: "u1",
        label: "mychannel",
        credentials: { clientId: CLIENT.id, accessToken: expect.stringMatching(/^access-/), refreshToken: expect.stringMatching(/^refresh-/), expiresAt: expect.any(Number) },
        facts: { userId: STREAMER.id, login: STREAMER.login, scopes: ALL_SCOPES },
        status: "active",
      }),
    ]);
    expect(twitch.calls("/oauth2/token").map((call) => call.body)).toEqual([
      { client_id: CLIENT.id, client_secret: CLIENT.secret, code: expect.stringMatching(/^code-/), grant_type: "authorization_code", redirect_uri: REDIRECT },
    ]);
  });

  it("reads the channel's chat as soon as it's connected, on a started runtime", async () => {
    const { jev, judged, errors } = site();
    await jev.start();

    await authorizeOn(jev, new URL(await jev.connectUrl("twitch")));
    await waitFor(() => twitch.subscriptions === 1, 3_000, "the chat subscription");
    twitch.chat("hi chat");
    await waitFor(() => judged.length === 1, 3_000, "the judged message");

    expect(judged[0]?.item).toMatchObject({ text: "hi chat", channel: "mychannel" });
    expect(judged[0]?.connection).toMatchObject({ id: "twitch:1000", label: "mychannel" });
    expect(errors).toEqual([]);
  });

  it("renews the account's token with the app's client secret, and saves the new tokens", async () => {
    const { jev } = site();
    await authorizeOn(jev, new URL(await jev.connectUrl("twitch")));
    const before = (await jev.store.connections.list())[0]?.credentials;
    twitch.expireTokens(STREAMER);

    await jev.start();
    await waitFor(() => twitch.subscriptions === 1, 3_000, "the chat subscription");

    expect(twitch.calls("/oauth2/token").at(-1)?.body).toMatchObject({ grant_type: "refresh_token", client_id: CLIENT.id, client_secret: CLIENT.secret });
    const after = (await jev.store.connections.list())[0]?.credentials;
    expect(after?.accessToken).not.toBe(before?.accessToken);
    expect(twitch.spent.has(before?.refreshToken as string)).toBe(true);
    expect(after).not.toHaveProperty("clientSecret");
  });

  it("reads the client ID and secret from TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET", async () => {
    vi.stubEnv("TWITCH_CLIENT_ID", CLIENT.id);
    vi.stubEnv("TWITCH_CLIENT_SECRET", CLIENT.secret);
    const { jev } = site({ app: app() });

    const done = await authorizeOn(jev, new URL(await jev.connectUrl("twitch")));

    expect(done.status).toBe(200);
    expect(await pageText(done)).toBe("Connected mychannel. You can close this tab. Jev Events");
  });

  it("says where to find the client ID and secret when they're missing", async () => {
    vi.stubEnv("TWITCH_CLIENT_ID", CLIENT.id);
    const { jev } = site({ app: app() });

    await expect(jev.connectUrl("twitch")).rejects.toThrow(
      "Twitch needs your app's credentials: set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET, or pass twitch.app({ clientId, clientSecret }). They're under Manage at https://dev.twitch.tv/console/apps, where the app's client type has to be Confidential to have a secret.",
    );
  });

  it("sends the streamer back when they click Cancel on Twitch", async () => {
    const { jev } = site();
    const consent = new URL(await jev.connectUrl("twitch", { returnTo: "/settings" }));
    const state = consent.searchParams.get("state");

    const done = await jev.handle(new Request(`${REDIRECT}?error=access_denied&error_description=The+user+denied+you+access&state=${state}`));

    expect([done.status, done.headers.get("location")]).toEqual([302, "/settings?connect_error=cancelled"]);
    expect(await jev.store.connections.list()).toEqual([]);
    expect(twitch.calls("/oauth2/token")).toEqual([]);
  });

  it.each([
    [
      "a wrong client secret",
      () => ({ app: app({ clientId: CLIENT.id, clientSecret: "wrong" }) }),
      "Twitch refused the sign-in: the client secret is wrong. Check TWITCH_CLIENT_SECRET.",
    ],
    [
      "a client ID Twitch doesn't know",
      () => ({ app: app({ clientId: "anotherclientid00000000000000", clientSecret: CLIENT.secret }) }),
      "Twitch refused the sign-in: the client ID is wrong. Check TWITCH_CLIENT_ID.",
    ],
    ["a code that was already used", () => ({ code: "code-used" }), "Twitch refused the sign-in: the code expired or was already used. Try connecting again."],
    [
      "a redirect URL the app doesn't list",
      () => ({ code: twitch.code("https://elsewhere.example/callback/twitch", STREAMER) }),
      `Twitch refused the sign-in: add ${REDIRECT} under OAuth Redirect URLs in your app at https://dev.twitch.tv/console/apps.`,
    ],
  ])("says what to fix, given %s", async (_, setup, message) => {
    const options = setup() as { app?: TwitchApp; code?: string };
    const { jev } = site(options.app ? { app: options.app } : {});
    const consent = new URL(await jev.connectUrl("twitch"));

    const done = options.code === undefined ? await authorizeOn(jev, consent) : await authorizeOn(jev, consent, options.code);

    expect(done.status).toBe(502);
    expect(await pageText(done)).toBe(`Couldn't finish signing in: ${message} Jev Events`);
    expect(await jev.store.connections.list()).toEqual([]);
  });
});
