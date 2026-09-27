import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authorize, CALENDAR_SCOPE, DEFAULT_SCOPES, GMAIL_SCOPE, SETUP_STEPS, withTokens, type AuthorizeOptions, type GoogleTokens } from "@jev-events/google";
import { fileStore, memoryStore, toConnection } from "jev-events";

import { clientFromFile } from "../src/authorize.js";
import { fakeGoogle, type FakeGoogle } from "./fake-google.js";
import { waitFor } from "./helpers.js";

let google: FakeGoogle;
let dir: string;
let home: string;
let storeDir: string;
let lines: string[];
let opened: URL[];

beforeEach(async () => {
  google = await fakeGoogle();
  dir = mkdtempSync(join(tmpdir(), "jev-google-authorize-"));
  home = join(dir, "home");
  mkdirSync(home);
  storeDir = join(dir, ".jev-events");
  vi.stubEnv("HOME", home);
  vi.stubEnv("JEV_EVENTS_KEY", undefined);
  vi.stubEnv("GOOGLE_CLIENT_ID", undefined);
  vi.stubEnv("GOOGLE_CLIENT_SECRET", undefined);
  lines = [];
  opened = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fileStore(storeDir).close?.();
  await google.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The browser: follows Google's redirect back to the local page, as if you clicked Allow. */
function browser(url: string): void {
  opened.push(new URL(url));
  void fetch(url).catch(() => {});
}

const print = (line: string) => void lines.push(line);
/** The Google connections saved in the file store. */
const connections = () => fileStore(storeDir).connections.list({ integration: "google" });
/** The credentials of the one saved connection. */
const saved = async () => {
  const all = await connections();
  expect(all.length).toBeLessThanOrEqual(1);
  return all[0]?.credentials as (GoogleTokens & { scopes?: string[] }) | undefined;
};

/** Sign in with the fake's OAuth client. */
const signIn = (options: AuthorizeOptions = {}) =>
  authorize({ "client-id": google.clientId, "client-secret": google.clientSecret, dir: storeDir, print, open: browser, ...options });

describe("authorize", () => {
  it("signs in with PKCE and saves the connection in .jev-events/store.json", async () => {
    const identity = await signIn();

    expect(identity).toEqual({
      email: "me@acme.com",
      scopes: DEFAULT_SCOPES,
      connection: expect.objectContaining({ id: "google:me@acme.com", integration: "google", label: "me@acme.com", facts: { email: "me@acme.com" }, status: "active" }),
    });
    expect(identity.connection).not.toHaveProperty("credentials");
    const url = opened[0]!;
    expect(`${url.origin}${url.pathname}`).toBe(`${google.url}/o/oauth2/v2/auth`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client-1",
      redirect_uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      response_type: "code",
      scope: DEFAULT_SCOPES.join(" "),
      code_challenge: expect.stringMatching(/^[\w-]{43}$/),
      code_challenge_method: "S256",
      state: expect.stringMatching(/^[\w-]{22}$/),
      access_type: "offline",
      prompt: "consent",
    });
    // On disk right away, so `jev-events watch` in another terminal finds it.
    const file = JSON.parse(readFileSync(join(storeDir, "store.json"), "utf8")) as { connections: Record<string, { credentials: GoogleTokens }> };
    const credentials = file.connections["google:me@acme.com"]?.credentials;
    expect(credentials).toEqual({
      clientId: "client-1",
      clientSecret: "secret-1",
      accessToken: expect.stringMatching(/^access-/),
      refreshToken: "refresh-2",
      expiresAt: expect.any(Number),
      scopes: DEFAULT_SCOPES,
    });
    await expect(withTokens(credentials!).refresh()).resolves.toMatch(/^access-/);
  });

  it("saves into the store you pass instead", async () => {
    const store = memoryStore();

    await signIn({ store });

    expect((await store.connections.list()).map((connection) => connection.id)).toEqual(["google:me@acme.com"]);
    expect(await connections()).toEqual([]);
    expect(lines).toContain("  Signed in as me@acme.com.");
  });

  it("replaces the connection when the same account signs in again", async () => {
    await signIn();
    await signIn();

    expect((await connections()).map((connection) => connection.id)).toEqual(["google:me@acme.com"]);
    expect((await saved())?.refreshToken).toBe("refresh-3");
  });

  it("prints the link, where it saved the sign-in and what to try next", async () => {
    await signIn();

    expect(lines).toContain(`  ${opened[0]!.href}`);
    expect(lines).toContain(`  Signed in as me@acme.com. Saved to ${join(storeDir, "store.json")}.`);
    expect(lines.slice(-3)).toEqual(["", "  Try it:  npx jev-events watch gmail", "           npx jev-events watch calendar"]);
    expect(lines.join("\n")).not.toMatch(/didn't allow|no refresh token/);
  });

  it("asks for only the access you pass, plus the address", async () => {
    const identity = await signIn({ scopes: "calendar" });

    expect(opened[0]?.searchParams.get("scope")).toBe(`openid email ${CALENDAR_SCOPE}`);
    expect(identity.scopes).toEqual(["openid", "email", CALENDAR_SCOPE]);
    expect(lines.join("\n")).not.toContain("didn't allow");
    expect(lines.slice(-2)).toEqual(["", "  Try it:  npx jev-events watch calendar"]);
  });

  it("takes full scope URLs, separated by commas or spaces", async () => {
    await signIn({ scopes: `${GMAIL_SCOPE}, ${CALENDAR_SCOPE}` });

    expect(opened[0]?.searchParams.get("scope")).toBe(DEFAULT_SCOPES.join(" "));
  });

  it.each([
    [[GMAIL_SCOPE], "Gmail"],
    [[CALENDAR_SCOPE], "Calendar"],
    [[GMAIL_SCOPE, CALENDAR_SCOPE], "Gmail or Calendar"],
  ])("says which access you didn't tick: %j", async (withheld, names) => {
    google.consent({ withhold: withheld });

    const identity = await signIn();

    expect(identity.scopes).toEqual(DEFAULT_SCOPES.filter((scope) => !withheld.includes(scope)));
    expect(lines).toContain(`  You didn't allow ${names}. To add it, run this again and tick every box.`);
  });

  it("warns when Google sends no refresh token", async () => {
    google.consent({ refreshToken: false });

    await signIn();

    expect(lines).toContain("  Google sent no refresh token, so you'll need to sign in again in an hour.");
    expect(await saved()).not.toHaveProperty("refreshToken");
  });

  it("names the connection after the account when Google doesn't share the address", async () => {
    google.consent({ withhold: ["openid", "email"] });

    const identity = await signIn();

    expect(identity.email).toBeUndefined();
    expect(identity.connection).toMatchObject({ id: "google:google", label: "google" });
    expect(identity.connection).not.toHaveProperty("facts");
    expect(lines).toContain(`  Signed in. Saved to ${join(storeDir, "store.json")}.`);
  });

  it("stops when you cancel on Google's page", async () => {
    google.consent({ deny: true });

    await expect(signIn()).rejects.toThrow("Sign-in cancelled.");
    expect(await saved()).toBeUndefined();
  });

  it("explains a wrong client secret", async () => {
    await expect(signIn({ "client-secret": "wrong" })).rejects.toThrow(
      "Google refused the sign-in: Unauthorized. Check the client ID and secret, or pass the right ones with --client-id and --client-secret.",
    );
    expect(await saved()).toBeUndefined();
  });

  it("ignores a stale sign-in link and gives up after the timeout", async () => {
    const pages: string[] = [];
    const stale = (url: string) => {
      const back = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
      back.search = new URLSearchParams({ code: "code-1", state: "from-an-old-tab" }).toString();
      void fetch(back).then(async (response) => pages.push(await response.text()));
    };

    await expect(signIn({ open: stale, timeoutMs: 200 })).rejects.toThrow("Timed out waiting for the browser. Run the command again.");
    await waitFor(() => pages.length === 1);

    expect(pages[0]).toContain("That sign-in link is stale. Run the command again.");
    expect(google.calls("POST /token")).toEqual([]);
  });
});

describe("finding your OAuth client", () => {
  it("reuses the client from the last sign-in", async () => {
    await signIn();

    await authorize({ dir: storeDir, print, open: browser });

    expect(opened[1]?.searchParams.get("client_id")).toBe("client-1");
    expect(google.calls("POST /token").at(-1)?.body).toMatchObject({ client_id: "client-1", client_secret: "secret-1" });
  });

  it("takes GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", google.clientId);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", google.clientSecret);

    await expect(authorize({ dir: storeDir, print, open: browser })).resolves.toMatchObject({ email: "me@acme.com" });
    expect(await saved()).toMatchObject({ clientId: "client-1", clientSecret: "secret-1" });
  });

  it("doesn't send the saved secret to a different client", async () => {
    await google.close();
    google = await fakeGoogle({ clientId: "public-client", clientSecret: "" });
    await fileStore(storeDir).connections.save(
      toConnection("google", { account: "old@acme.com", credentials: { clientId: "old-client", clientSecret: "old-secret", refreshToken: "refresh-old" } }),
    );

    await authorize({ "client-id": "public-client", dir: storeDir, print, open: browser });

    expect(google.calls("POST /token")[0]?.body).not.toHaveProperty("client_secret");
    const connection = (await connections()).find((saved) => saved.id === "google:me@acme.com");
    expect(connection?.credentials).toMatchObject({ clientId: "public-client" });
    expect(connection?.credentials).not.toHaveProperty("clientSecret");
  });
});

describe("first-time setup", () => {
  const QUESTION = "  Downloaded it? Press Enter (or drag the file here): ";
  const client = () => ({ installed: { client_id: google.clientId, client_secret: google.clientSecret } });

  /** Save a file as if downloaded from Google's console. */
  function download(name: string, content: unknown, modified?: Date): string {
    const file = join(home, "Downloads", name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
    if (modified) utimesSync(file, modified, modified);
    return file;
  }

  /** A terminal where you give these answers in order, then press Enter. */
  function terminal(...replies: string[]) {
    const asked: string[] = [];
    const ask = async (question: string) => {
      asked.push(question);
      return replies.shift() ?? "";
    };
    return { asked, ask };
  }

  it("walks you through creating a client, then uses the file you just downloaded", async () => {
    download("client_secret_old.apps.googleusercontent.com.json", { installed: { client_id: "old-client" } }, new Date("2026-01-01"));
    const file = download("client_secret_new.apps.googleusercontent.com.json", client());
    const { asked, ask } = terminal("");

    await authorize({ dir: storeDir, print, open: browser, ask });

    expect(lines).toEqual(
      expect.arrayContaining([
        "  Google needs an OAuth client of your own. One-time setup, about 3 minutes:",
        ...SETUP_STEPS.map((step, index) => `  ${index + 1}. ${step}`),
        `  Using ${file}`,
      ]),
    );
    expect(asked).toEqual([QUESTION]);
    expect(await saved()).toMatchObject({ clientId: "client-1", clientSecret: "secret-1" });
  });

  it.each([
    ["in quotes", (file: string) => `'${file}' `],
    ["in double quotes", (file: string) => `"${file}"`],
    ["with escaped spaces", (file: string) => `${file.replace(/ /g, "\\ ")} `],
  ])("takes a file dragged into the terminal %s", async (_name, drag) => {
    const file = join(dir, "Google Cloud", "client secret.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(client()));

    await authorize({ dir: storeDir, print, open: browser, ask: terminal(drag(file)).ask });

    expect(lines).toContain(`  Using ${file}`);
    expect(await saved()).toMatchObject({ clientId: "client-1" });
  });

  it("takes a client ID and secret pasted instead of the file", async () => {
    const { asked, ask } = terminal(google.clientId, google.clientSecret);

    await authorize({ dir: storeDir, print, open: browser, ask });

    expect(asked).toEqual([QUESTION, "  Client secret: "]);
    expect(await saved()).toMatchObject({ clientId: "client-1", clientSecret: "secret-1" });
  });

  it("asks again until it gets a client file, saying what was wrong", async () => {
    const notJson = join(dir, "notes.txt");
    writeFileSync(notJson, "hello");
    const serviceAccount = join(dir, "service-account.json");
    writeFileSync(serviceAccount, JSON.stringify({ type: "service_account" }));
    const web = join(dir, "web-client.json");
    writeFileSync(web, JSON.stringify({ web: { client_id: google.clientId, client_secret: google.clientSecret } }));
    const { asked, ask } = terminal("", notJson, serviceAccount, web);

    await authorize({ dir: storeDir, print, open: browser, ask });

    expect(asked).toHaveLength(4);
    expect(lines).toEqual(
      expect.arrayContaining([
        `  No client_secret_….json in ${join(home, "Downloads")} yet. Drag the file here instead.`,
        `  Couldn't read ${notJson}. Is it the JSON file from Google's console?`,
        `  ${serviceAccount} has no client_id. Download the JSON of a "Desktop app" client.`,
        `  Using ${web}`,
      ]),
    );
    expect(await saved()).toMatchObject({ clientId: "client-1" });
  });

  it("gives up after five tries", async () => {
    const { asked, ask } = terminal();

    await expect(authorize({ dir: storeDir, print, open: browser, ask })).rejects.toThrow("No OAuth client given.");
    expect(asked).toHaveLength(5);
    expect(google.requests).toEqual([]);
  });

  it("explains the setup instead of asking when there's no terminal", async () => {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true, writable: true });
    try {
      await expect(authorize({ dir: storeDir, print, open: browser })).rejects.toThrow(
        [
          "Google needs an OAuth client of your own first (one-time, about 3 minutes):",
          "",
          ...SETUP_STEPS.map((step, index) => `  ${index + 1}. ${step}`),
          "",
          "  Then run: npx jev-events auth google --client-id <id> --client-secret <secret>",
        ].join("\n"),
      );
    } finally {
      if (original) Object.defineProperty(process.stdin, "isTTY", original);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    expect(opened).toEqual([]);
  });
});

describe("clientFromFile", () => {
  it("reads a Desktop or Web client, with or without a secret", () => {
    const file = join(dir, "client.json");

    writeFileSync(file, JSON.stringify({ installed: { client_id: "desktop", client_secret: "shh" } }));
    expect(clientFromFile(file)).toEqual({ clientId: "desktop", clientSecret: "shh" });

    writeFileSync(file, JSON.stringify({ web: { client_id: "web" } }));
    expect(clientFromFile(file)).toEqual({ clientId: "web" });
  });

  it("says what's wrong with a file that isn't a client", () => {
    const missing = join(dir, "missing.json");

    expect(() => clientFromFile(missing)).toThrow(`Couldn't read ${missing}. Is it the JSON file from Google's console?`);
  });
});
