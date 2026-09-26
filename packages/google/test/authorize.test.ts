import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authorize, CALENDAR_SCOPE, DEFAULT_SCOPES, fromFile, GMAIL_SCOPE, SETUP_STEPS, type AuthorizeOptions, type GoogleTokens } from "@jev-events/google";
import { readCredentials, writeCredentials } from "jev-events";

import { clientFromFile } from "../src/authorize.js";
import { fakeGoogle, type FakeGoogle } from "./fake-google.js";
import { waitFor } from "./helpers.js";

let google: FakeGoogle;
let dir: string;
let home: string;
let path: string;
let lines: string[];
let opened: URL[];

beforeEach(async () => {
  google = await fakeGoogle();
  dir = mkdtempSync(join(tmpdir(), "jev-google-authorize-"));
  home = join(dir, "home");
  mkdirSync(home);
  path = join(dir, "credentials.json");
  vi.stubEnv("HOME", home);
  vi.stubEnv("GOOGLE_CLIENT_ID", undefined);
  vi.stubEnv("GOOGLE_CLIENT_SECRET", undefined);
  lines = [];
  opened = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await google.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The browser: follows Google's redirect back to the local page, as if you clicked Allow. */
function browser(url: string): void {
  opened.push(new URL(url));
  void fetch(url).catch(() => {});
}

const print = (line: string) => void lines.push(line);
const saved = () => readCredentials<GoogleTokens>("google", path);

/** Sign in with the fake's OAuth client. */
const signIn = (options: AuthorizeOptions = {}) =>
  authorize({ "client-id": google.clientId, "client-secret": google.clientSecret, path, print, open: browser, ...options });

describe("authorize", () => {
  it("signs in with PKCE and saves tokens that fromFile() can use", async () => {
    const identity = await signIn();

    expect(identity).toEqual({ email: "me@acme.com", scopes: DEFAULT_SCOPES });
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
    expect(saved()).toEqual({
      clientId: "client-1",
      clientSecret: "secret-1",
      accessToken: expect.stringMatching(/^access-/),
      refreshToken: "refresh-2",
      expiresAt: expect.any(Number),
      email: "me@acme.com",
      scopes: DEFAULT_SCOPES,
    });
    await expect(fromFile(path).refresh()).resolves.toMatch(/^access-/);
  });

  it("prints the link, where it saved the sign-in and what to try next", async () => {
    await signIn();

    expect(lines).toContain(`  ${opened[0]!.href}`);
    expect(lines).toContain(`  Signed in as me@acme.com. Saved to ${path}.`);
    expect(lines.slice(-3)).toEqual(["", "  Try it:  npx jev-events watch gmail", "           npx jev-events watch calendar"]);
    expect(lines.join("\n")).not.toMatch(/didn't allow|no refresh token/);
  });

  it("asks for only the scopes you pass", async () => {
    const identity = await signIn({ scopes: `openid, email ${CALENDAR_SCOPE}` });

    expect(opened[0]?.searchParams.get("scope")).toBe(`openid email ${CALENDAR_SCOPE}`);
    expect(identity.scopes).toEqual(["openid", "email", CALENDAR_SCOPE]);
    expect(lines.join("\n")).not.toContain("didn't allow");
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
    expect(saved()).not.toHaveProperty("refreshToken");
  });

  it("leaves out the address when you don't share it", async () => {
    const identity = await signIn({ scopes: GMAIL_SCOPE });

    expect(identity.email).toBeUndefined();
    expect(saved()).not.toHaveProperty("email");
    expect(lines).toContain(`  Signed in. Saved to ${path}.`);
  });

  it("stops when you cancel on Google's page", async () => {
    google.consent({ deny: true });

    await expect(signIn()).rejects.toThrow("Sign-in cancelled.");
    expect(saved()).toBeUndefined();
  });

  it("explains a wrong client secret", async () => {
    await expect(signIn({ "client-secret": "wrong" })).rejects.toThrow(
      "Google refused the sign-in: Unauthorized. Check the client ID and secret, or delete them and run this again to set up a new client.",
    );
    expect(saved()).toBeUndefined();
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

    await authorize({ path, print, open: browser });

    expect(opened[1]?.searchParams.get("client_id")).toBe("client-1");
    expect(google.calls("POST /token").at(-1)?.body).toMatchObject({ client_id: "client-1", client_secret: "secret-1" });
  });

  it("takes GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", google.clientId);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", google.clientSecret);

    await expect(authorize({ path, print, open: browser })).resolves.toMatchObject({ email: "me@acme.com" });
  });

  it("doesn't send the saved secret to a different client", async () => {
    await google.close();
    google = await fakeGoogle({ clientId: "public-client", clientSecret: "" });
    writeCredentials("google", { clientId: "old-client", clientSecret: "old-secret", refreshToken: "refresh-old" }, path);

    await authorize({ "client-id": "public-client", path, print, open: browser });

    expect(google.calls("POST /token")[0]?.body).not.toHaveProperty("client_secret");
    expect(saved()).toMatchObject({ clientId: "public-client" });
    expect(saved()).not.toHaveProperty("clientSecret");
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

    await authorize({ path, print, open: browser, ask });

    expect(lines).toEqual(
      expect.arrayContaining([
        "  Google needs an OAuth client of your own. One-time setup, about 3 minutes:",
        ...SETUP_STEPS.map((step, index) => `  ${index + 1}. ${step}`),
        `  Using ${file}`,
      ]),
    );
    expect(asked).toEqual([QUESTION]);
    expect(saved()).toMatchObject({ clientId: "client-1", clientSecret: "secret-1", email: "me@acme.com" });
  });

  it.each([
    ["in quotes", (file: string) => `'${file}' `],
    ["in double quotes", (file: string) => `"${file}"`],
    ["with escaped spaces", (file: string) => `${file.replace(/ /g, "\\ ")} `],
  ])("takes a file dragged into the terminal %s", async (_name, drag) => {
    const file = join(dir, "Google Cloud", "client secret.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(client()));

    await authorize({ path, print, open: browser, ask: terminal(drag(file)).ask });

    expect(lines).toContain(`  Using ${file}`);
    expect(saved()).toMatchObject({ clientId: "client-1" });
  });

  it("takes a client ID and secret pasted instead of the file", async () => {
    const { asked, ask } = terminal(google.clientId, google.clientSecret);

    await authorize({ path, print, open: browser, ask });

    expect(asked).toEqual([QUESTION, "  Client secret: "]);
    expect(saved()).toMatchObject({ clientId: "client-1", clientSecret: "secret-1" });
  });

  it("asks again until it gets a client file, saying what was wrong", async () => {
    const notJson = join(dir, "notes.txt");
    writeFileSync(notJson, "hello");
    const serviceAccount = join(dir, "service-account.json");
    writeFileSync(serviceAccount, JSON.stringify({ type: "service_account" }));
    const web = join(dir, "web-client.json");
    writeFileSync(web, JSON.stringify({ web: { client_id: google.clientId, client_secret: google.clientSecret } }));
    const { asked, ask } = terminal("", notJson, serviceAccount, web);

    await authorize({ path, print, open: browser, ask });

    expect(asked).toHaveLength(4);
    expect(lines).toEqual(
      expect.arrayContaining([
        `  No client_secret_….json in ${join(home, "Downloads")} yet. Drag the file here instead.`,
        `  Couldn't read ${notJson}. Is it the JSON file from Google's console?`,
        `  ${serviceAccount} has no client_id. Download the JSON of a "Desktop app" client.`,
        `  Using ${web}`,
      ]),
    );
    expect(saved()).toMatchObject({ clientId: "client-1" });
  });

  it("gives up after five tries", async () => {
    const { asked, ask } = terminal();

    await expect(authorize({ path, print, open: browser, ask })).rejects.toThrow("No OAuth client given.");
    expect(asked).toHaveLength(5);
    expect(google.requests).toEqual([]);
  });

  it("explains the setup instead of asking when there's no terminal", async () => {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true, writable: true });
    try {
      await expect(authorize({ path, print, open: browser })).rejects.toThrow(
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
