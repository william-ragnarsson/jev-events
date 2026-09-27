import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authorize, DEFAULT_SCOPES, SETUP_STEPS, withTokens, type AuthorizeOptions, type TwitchTokens } from "@jev-events/twitch";
import { fileStore, memoryStore } from "jev-events";

import { BOT, CLIENT, fakeTwitch, STREAMER, type FakeTwitch } from "./fake-twitch.js";

// `npx jev-events auth twitch`: approving a code on Twitch, the one-time app setup it walks you
// through, and where the connection is saved.

let twitch: FakeTwitch;
let dir: string;
let lines: string[];
let opened: string[];

beforeEach(async () => {
  twitch = await fakeTwitch();
  dir = join(mkdtempSync(join(tmpdir(), "jev-twitch-authorize-")), ".jev-events");
  vi.stubEnv("JEV_EVENTS_KEY", undefined);
  lines = [];
  opened = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fileStore(dir).close?.();
  await twitch.close();
  rmSync(join(dir, ".."), { recursive: true, force: true });
});

/** The code the activation page shows, which you check before approving. */
const userCode = (url: string) => /device-code=(\w+)/.exec(url)?.[1] ?? "";
/** The browser: approves the code on Twitch as `user`, as if you clicked Authorize. */
const approveAs =
  (user: { id: string } = BOT) =>
  (url: string) => {
    opened.push(url);
    twitch.approve(userCode(url), user);
  };

const authorizeWith = (options: AuthorizeOptions) => authorize({ dir, env: {}, print: (line) => void lines.push(line), open: approveAs(), ...options });
/** Sign in with the fake's Client ID. */
const connect = (options: AuthorizeOptions = {}) => authorizeWith({ "client-id": CLIENT.id, ...options });
const steps = SETUP_STEPS.map((step, index) => `  ${index + 1}. ${step}`);
/** The Twitch connections saved in the file store. */
const connections = () => fileStore(dir).connections.list({ integration: "twitch" });
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** Run with stdin not a terminal, as when piped, so authorize can't ask. */
async function withoutTerminal<T>(run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true, writable: true });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(process.stdin, "isTTY", original);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
}

describe("authorize", () => {
  it("signs in with a code approved on Twitch and saves the connection in .jev-events/store.json", async () => {
    const account = await connect();

    expect(account).toEqual({
      userId: BOT.id,
      login: BOT.login,
      scopes: DEFAULT_SCOPES,
      connection: expect.objectContaining({
        id: "twitch:999",
        integration: "twitch",
        label: "jevbot",
        facts: { userId: BOT.id, login: BOT.login, scopes: DEFAULT_SCOPES },
        status: "active",
      }),
    });
    expect(account.connection).not.toHaveProperty("credentials");
    expect(twitch.calls("/oauth2/device")).toMatchObject([{ method: "POST", body: { client_id: CLIENT.id, scopes: DEFAULT_SCOPES.join(" ") } }]);
    expect(twitch.calls("/oauth2/token")).toMatchObject([{ body: { client_id: CLIENT.id, grant_type: DEVICE_GRANT, scopes: DEFAULT_SCOPES.join(" ") } }]);
    // On disk right away, so `jev-events watch twitch` in another terminal finds it.
    const file = JSON.parse(readFileSync(join(dir, "store.json"), "utf8")) as { connections: Record<string, { credentials: TwitchTokens }> };
    const credentials = file.connections["twitch:999"]?.credentials;
    expect(credentials).toEqual({
      clientId: CLIENT.id,
      accessToken: expect.stringMatching(/^access-/),
      refreshToken: expect.stringMatching(/^refresh-/),
      expiresAt: expect.any(Number),
    });
    expect(credentials?.expiresAt).toBeGreaterThan(Date.now() + 3_600_000);
    // A Public app's tokens renew without a secret.
    await expect(withTokens(credentials!).refresh()).resolves.toMatch(/^access-/);
  });

  it("prints the page to open, the code to check, where it saved the sign-in and what to try next", async () => {
    await connect();
    const url = opened[0]!;

    expect(url).toMatch(/^https:\/\/www\.twitch\.tv\/activate\?device-code=\w+$/);
    expect(lines).toEqual([
      "",
      "  Opening Twitch in your browser. If it doesn't open, go to:",
      `  ${url}`,
      "",
      `  Check that Twitch shows the code ${userCode(url)}, then click Authorize.`,
      "",
      `  Signed in as jevbot. Saved to ${join(dir, "store.json")}.`,
      "  To act in someone else's channel, jevbot has to be a moderator there. The broadcaster types in chat: /mod jevbot",
      "",
      "  Try it:  npx jev-events watch twitch",
    ]);
  });

  it("saves into the store you pass instead", async () => {
    const store = memoryStore();

    await connect({ store });

    expect((await store.connections.list()).map((connection) => connection.id)).toEqual(["twitch:999"]);
    expect(await connections()).toEqual([]);
    expect(lines).toContain("  Signed in as jevbot.");
  });

  it("replaces the connection when the same account signs in again, and adds one for another account", async () => {
    await connect();
    await connect();
    await connect({ open: approveAs(STREAMER) });

    expect((await connections()).map((connection) => connection.label).sort()).toEqual(["jevbot", "mychannel"]);
  });

  it("keeps asking Twitch until you approve the code", async () => {
    const later = (url: string) => void setTimeout(() => twitch.approve(userCode(url)), 150);

    const account = await connect({ open: later });

    expect(account.login).toBe(BOT.login);
    expect(twitch.calls("/oauth2/token").length).toBeGreaterThan(1);
  });

  it("always asks to read chat, whatever else you ask for", async () => {
    const account = await connect({ scopes: "clips:edit, moderator:manage:banned_users" });
    await connect({ scopes: "user:write:chat user:read:chat" });

    expect(twitch.calls("/oauth2/device").map((call) => (call.body as { scopes?: string }).scopes)).toEqual([
      "user:read:chat clips:edit moderator:manage:banned_users",
      "user:read:chat user:write:chat",
    ]);
    expect(account.scopes).toEqual(["user:read:chat", "clips:edit", "moderator:manage:banned_users"]);
  });

  it("stops when you click Decline on Twitch", async () => {
    await expect(connect({ open: (url) => twitch.deny(userCode(url)) })).rejects.toThrow("Sign-in cancelled.");
    expect(await connections()).toEqual([]);
  });

  it("says when the code expires before anyone approves it", async () => {
    await expect(connect({ open: (url) => twitch.expire(userCode(url)) })).rejects.toThrow(
      "The code expired before it was approved. Run the command again.",
    );
    expect(await connections()).toEqual([]);
  });

  it("explains a Client ID Twitch doesn't know", async () => {
    await expect(connect({ "client-id": "wrongclientid0000000000000000" })).rejects.toThrow(
      "Twitch didn't accept the Client ID wrongclientid0000000000000000 (invalid client). Copy it again under Manage at https://dev.twitch.tv/console/apps",
    );
    expect(opened).toEqual([]);
  });
});

describe("the Client ID", () => {
  it("walks you through creating the app the first time, then asks for its Client ID", async () => {
    const asked: string[] = [];
    const answers = ["", "not an id", CLIENT.id];

    await authorizeWith({
      ask: async (question) => {
        asked.push(question);
        return answers.shift() ?? "";
      },
    });

    expect(asked).toEqual(["  Client ID: ", "  Client ID: ", "  Client ID: "]);
    expect(lines.slice(0, 9)).toEqual([
      "",
      "  Twitch needs an app of your own. One-time setup, about 2 minutes:",
      "",
      ...steps,
      "",
      "  That doesn't look like a Client ID, which is about 30 letters and digits under Manage.",
      "",
    ]);
    expect((await connections())[0]?.credentials).toMatchObject({ clientId: CLIENT.id });
  });

  it("gives up after three answers that aren't a Client ID", async () => {
    const ask = vi.fn(async () => "nope");

    await expect(authorizeWith({ ask })).rejects.toThrow("No Client ID given.");
    expect(ask).toHaveBeenCalledTimes(3);
    expect(twitch.calls()).toEqual([]);
  });

  it("prints the setup steps and the command to run when there's no terminal to ask in", async () => {
    await expect(withoutTerminal(() => authorizeWith({}))).rejects.toThrow(
      `Twitch needs an app of your own first (one-time, about 2 minutes):\n\n${steps.join("\n")}\n\n  Then run: npx jev-events auth twitch --client-id <id>`,
    );
    expect(twitch.calls()).toEqual([]);
  });

  it("reuses the Client ID of the last sign-in", async () => {
    await connect();
    const ask = vi.fn(async () => "");

    await authorizeWith({ ask });

    expect(ask).not.toHaveBeenCalled();
    expect(twitch.calls("/oauth2/device").map((call) => (call.body as { client_id?: string }).client_id)).toEqual([CLIENT.id, CLIENT.id]);
  });

  it("reads TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET, and saves the secret to renew the tokens with", async () => {
    await authorizeWith({ env: { TWITCH_CLIENT_ID: CLIENT.id, TWITCH_CLIENT_SECRET: CLIENT.secret } });

    expect(twitch.calls("/oauth2/token")).toMatchObject([{ body: { client_id: CLIENT.id, client_secret: CLIENT.secret, grant_type: DEVICE_GRANT } }]);
    expect((await connections())[0]?.credentials).toMatchObject({ clientId: CLIENT.id, clientSecret: CLIENT.secret });
  });

  it("doesn't send TWITCH_CLIENT_SECRET along with another app's Client ID", async () => {
    await connect({ env: { TWITCH_CLIENT_ID: "anotherclientid00000000000000", TWITCH_CLIENT_SECRET: "another-secret" } });

    expect(twitch.calls("/oauth2/token")[0]?.body).not.toHaveProperty("client_secret");
    expect((await connections())[0]?.credentials).not.toHaveProperty("clientSecret");
  });

  it("explains a client secret Twitch doesn't accept", async () => {
    await expect(connect({ "client-secret": "wrong" })).rejects.toThrow(
      "Twitch didn't accept the client secret (invalid client secret). Check --client-secret or TWITCH_CLIENT_SECRET, or leave it out for a Public app.",
    );
    expect(await connections()).toEqual([]);
  });
});
