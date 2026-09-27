import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { app, inbox, type MicrosoftApp } from "@jev-events/microsoft";
import { memoryStore, monitor, noul, runtime, silentLogger, type Runtime } from "jev-events";
import { mockJev } from "jev-events/testing";

import { fakeMicrosoft, type FakeMicrosoft } from "./fake-microsoft.js";

// Letting people connect their Microsoft account on your site: microsoft.app() behind
// /connect/microsoft and /callback/microsoft.

const BASE = "https://example.com/api/jev";
const REDIRECT = `${BASE}/callback/microsoft`;

let microsoft: FakeMicrosoft;
let sites: Runtime[];

beforeEach(async () => {
  microsoft = await fakeMicrosoft({ clientSecret: "web-secret" });
  for (const name of ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_TENANT"]) vi.stubEnv(name, undefined);
  sites = [];
});

afterEach(async () => {
  await Promise.all(sites.map((jev) => jev.stop()));
  vi.unstubAllEnvs();
  await microsoft.close();
});

function site(options: { app?: MicrosoftApp } = {}) {
  const mail = monitor({ source: inbox(), questions: { urgent: noul("Is this email urgent?") }, client: mockJev(() => ({ urgent: 0.1 })), log: silentLogger });
  const jev = runtime({
    monitors: [mail],
    store: memoryStore(),
    apps: [options.app ?? app({ clientId: microsoft.clientId, clientSecret: "web-secret" })],
    baseUrl: BASE,
    log: silentLogger,
  });
  sites.push(jev);
  return jev;
}

/** Visit Microsoft's consent page and follow it back to the callback, as the browser does. */
async function consentOn(jev: Runtime, consent: string): Promise<Response> {
  const response = await fetch(consent, { redirect: "manual" });
  const location = response.headers.get("location");
  if (response.status !== 302 || !location) throw new Error(`Microsoft answered ${response.status}: ${await response.text()}`);
  return jev.handle(new Request(location));
}

describe("microsoft.app()", () => {
  it("sends people to Microsoft's consent page with PKCE and every permission the sources need", async () => {
    const jev = site();

    const consent = new URL(await jev.connectUrl("microsoft", { scopes: ["Files.Read"] }));

    expect(consent.origin + consent.pathname).toBe(`${microsoft.url}/common/oauth2/v2.0/authorize`);
    expect(Object.fromEntries(consent.searchParams)).toMatchObject({
      client_id: microsoft.clientId,
      response_type: "code",
      redirect_uri: REDIRECT,
      code_challenge_method: "S256",
      code_challenge: expect.any(String),
      state: expect.any(String),
      prompt: "select_account",
    });
    expect(consent.searchParams.get("scope")?.split(" ")).toEqual(
      expect.arrayContaining(["offline_access", "User.Read", "Mail.ReadWrite", "Calendars.ReadWrite", "Chat.ReadWrite", "Files.Read"]),
    );
  });

  it("saves the account when they click Accept, with the tokens and who they are", async () => {
    const jev = site();

    const done = await consentOn(jev, await jev.connectUrl("microsoft", { userId: "u1", returnTo: "/settings" }));

    expect([done.status, done.headers.get("location")]).toEqual([302, "/settings?connected=microsoft"]);
    const [saved] = await jev.store.connections.list();
    expect(saved).toMatchObject({
      id: "microsoft:u1:user-me",
      integration: "microsoft",
      userId: "u1",
      label: "me@acme.com",
      facts: { userId: "user-me", email: "me@acme.com", name: "Me Myself" },
      credentials: { accessToken: expect.any(String), refreshToken: expect.any(String), scopes: expect.arrayContaining(["Mail.ReadWrite"]) },
    });
    expect(saved?.credentials).not.toHaveProperty("clientSecret");
    expect(microsoft.calls("POST /token")[0]?.body).toMatchObject({ grant_type: "authorization_code", client_secret: "web-secret", redirect_uri: REDIRECT });
  });

  it("marks a personal account, whose id token carries Microsoft's consumer tenant", async () => {
    await microsoft.close();
    microsoft = await fakeMicrosoft({ clientSecret: "web-secret", personal: true, me: "me@outlook.com" });
    const jev = site();

    await consentOn(jev, await jev.connectUrl("microsoft"));

    expect((await jev.store.connections.list())[0]?.facts).toMatchObject({ personal: true, email: "me@outlook.com" });
  });

  it("saves nothing when they decline", async () => {
    const jev = site();
    microsoft.consent({ deny: true });

    const done = await consentOn(jev, await jev.connectUrl("microsoft", { returnTo: "/settings" }));

    expect(done.status).toBeGreaterThanOrEqual(300);
    expect(await jev.store.connections.list()).toEqual([]);
  });

  it("says to check the client ID and secret when Microsoft refuses the app", async () => {
    const jev = site({ app: app({ clientId: microsoft.clientId, clientSecret: "expired-secret" }) });

    const done = await consentOn(jev, await jev.connectUrl("microsoft"));

    expect(done.status).toBeGreaterThanOrEqual(400);
    expect(await done.text()).toContain("Check MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET");
    expect(await jev.store.connections.list()).toEqual([]);
  });

  it("reads the app registration from the environment", async () => {
    vi.stubEnv("MICROSOFT_CLIENT_ID", microsoft.clientId);
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "web-secret");
    vi.stubEnv("MICROSOFT_TENANT", "contoso.onmicrosoft.com");
    const jev = site({ app: app() });

    const consent = new URL(await jev.connectUrl("microsoft"));

    expect(consent.pathname).toBe("/contoso.onmicrosoft.com/oauth2/v2.0/authorize");
    expect(consent.searchParams.get("client_id")).toBe(microsoft.clientId);
  });

  it("says how to register an app when there's no client ID", async () => {
    const jev = site({ app: app() });

    await expect(jev.connectUrl("microsoft")).rejects.toThrow(/^Microsoft needs your app registration: set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET/);
  });
});
