import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authorize, SETUP_STEPS, type AuthorizeOptions, type MicrosoftTokens } from "@jev-events/microsoft";
import { fileStore, memoryStore, toConnection } from "jev-events";

import { fakeMicrosoft, type FakeMicrosoft } from "./fake-microsoft.js";

let microsoft: FakeMicrosoft;
let dir: string;
let storeDir: string;
let lines: string[];
let opened: string[];

beforeEach(async () => {
  microsoft = await fakeMicrosoft();
  dir = mkdtempSync(join(tmpdir(), "jev-microsoft-authorize-"));
  storeDir = join(dir, ".jev-events");
  vi.stubEnv("JEV_EVENTS_KEY", undefined);
  vi.stubEnv("MICROSOFT_CLIENT_ID", undefined);
  vi.stubEnv("MICROSOFT_TENANT", undefined);
  lines = [];
  opened = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fileStore(storeDir).close?.();
  await microsoft.close();
  rmSync(dir, { recursive: true, force: true });
});

const print = (line: string) => void lines.push(line);
const open = (url: string) => void opened.push(url);
const noAnswers = async () => {
  throw new Error("It shouldn't ask anything.");
};
/** The Microsoft connections saved in the file store. */
const connections = () => fileStore(storeDir).connections.list({ integration: "microsoft" });

/** Sign in with the fake's app registration, never opening a real browser. */
const signIn = (options: AuthorizeOptions = {}) => authorize({ "client-id": microsoft.clientId, dir: storeDir, print, open, ask: noAnswers, ...options });

async function failure(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("Expected it to fail.");
    },
    (error: unknown) => error as Error,
  );
}

describe("authorize", () => {
  it("signs in with a code, saves the connection and says what to try", async () => {
    const account = await signIn();

    expect(account).toMatchObject({ userId: "user-me", email: "me@acme.com", name: "Me Myself" });
    expect(account.scopes).toEqual(expect.arrayContaining(["Mail.ReadWrite", "Calendars.ReadWrite", "Chat.ReadWrite"]));
    expect(opened).toEqual(["https://microsoft.com/devicelogin"]);
    expect(lines).toContain("  Enter the code CODE00001, then sign in and click Accept.");
    expect(lines).toContain(`  Signed in as me@acme.com. Saved to ${join(storeDir, "store.json")}.`);
    expect(lines.at(-1)).toBe("  Try it:  npx jev-events watch outlook");

    const [saved] = await connections();
    expect(saved).toMatchObject({ id: "microsoft:user-me", label: "me@acme.com", facts: { userId: "user-me", email: "me@acme.com", name: "Me Myself" } });
    const credentials = saved?.credentials as unknown as MicrosoftTokens;
    expect(credentials).toMatchObject({ clientId: microsoft.clientId, accessToken: expect.any(String), refreshToken: expect.any(String) });
    expect(credentials).not.toHaveProperty("tenant");
    expect(credentials).not.toHaveProperty("clientSecret");

    const [code] = microsoft.calls("POST /devicecode");
    expect(code?.tenant).toBe("common");
    expect((code?.body as { scope: string }).scope.split(" ")).toEqual(
      expect.arrayContaining(["openid", "offline_access", "User.Read", "Mail.ReadWrite", "Calendars.ReadWrite", "Chat.ReadWrite"]),
    );
  });

  it("keeps asking while the code waits for approval", async () => {
    microsoft.device({ pending: 2 });

    await signIn();

    expect(microsoft.calls("POST /token")).toHaveLength(3);
  });

  it("asks only for what --scopes names, and remembers the tenant", async () => {
    const account = await signIn({ scopes: "outlook,calendar", tenant: "contoso.onmicrosoft.com" });

    expect(account.scopes).not.toContain("Chat.ReadWrite");
    expect(lines.join("\n")).not.toContain("Teams only works with work or school accounts");
    expect(microsoft.calls("POST /devicecode")[0]?.tenant).toBe("contoso.onmicrosoft.com");
    expect((await connections())[0]?.credentials).toMatchObject({ tenant: "contoso.onmicrosoft.com" });
  });

  it("reuses the app and tenant of the last sign-in", async () => {
    const store = memoryStore();
    const earlier = microsoft.connection();
    await store.connections.save(toConnection("microsoft", { ...earlier, account: "old", credentials: { ...earlier.credentials, tenant: "contoso.onmicrosoft.com" } }));

    await authorize({ store, print, open, ask: noAnswers });

    expect(microsoft.calls("POST /devicecode")[0]).toMatchObject({ tenant: "contoso.onmicrosoft.com", body: { client_id: microsoft.clientId } });
    expect(lines.join("\n")).not.toContain("Saved to");
  });

  it("notes that a personal account can't use Teams", async () => {
    await microsoft.close();
    microsoft = await fakeMicrosoft({ personal: true, me: "me@outlook.com" });

    const account = await signIn({ scopes: "outlook,calendar,Chat.ReadWrite" });

    expect(account.scopes).not.toContain("Chat.ReadWrite");
    expect((await connections())[0]?.facts).toMatchObject({ personal: true, email: "me@outlook.com" });
  });

  it("walks through registering an app when there's no client ID, then asks for it", async () => {
    const answers = ["", "not-an-id", microsoft.clientId];

    await authorize({ dir: storeDir, print, open, ask: async () => answers.shift() ?? "" });

    expect(lines).toContain("  Microsoft needs an app registration of your own. One-time setup, about 3 minutes:");
    expect(lines).toContain(`  1. ${SETUP_STEPS[0]}`);
    expect(lines).toContain("  That doesn't look like an Application (client) ID, which looks like 1b2c3d4e-0000-1111-2222-333344445555.");
    expect(await connections()).toHaveLength(1);
  });

  it("prints the setup steps and the command when it can't ask", async () => {
    const error = await failure(authorize({ dir: storeDir, print, open }));

    expect(error.message).toContain("Microsoft needs an app registration of your own first");
    expect(error.message).toContain(`  1. ${SETUP_STEPS[0]}`);
    expect(error.message).toMatch(/Then run: npx jev-events auth microsoft --client-id <id>$/);
    expect(microsoft.requests).toHaveLength(0);
  });

  it("gives up after three answers that aren't client IDs", async () => {
    const error = await failure(authorize({ dir: storeDir, print, open, ask: async () => "nope" }));

    expect(error.message).toBe("No Application (client) ID given.");
  });

  it("refuses a client ID that isn't one", async () => {
    const error = await failure(signIn({ "client-id": "my-app" }));

    expect(error.message).toBe("my-app isn't an Application (client) ID, which looks like 1b2c3d4e-0000-1111-2222-333344445555. Copy it from your app's Overview.");
  });

  it("says when Microsoft doesn't know the app", async () => {
    const error = await failure(signIn({ "client-id": "99999999-9999-9999-9999-999999999999", tenant: "contoso.onmicrosoft.com" }));

    expect(error.message).toMatch(
      /^Microsoft didn't accept the app 99999999-9999-9999-9999-999999999999 \(AADSTS700016: .*\)\. Check the Application \(client\) ID on your app's Overview and the tenant contoso\.onmicrosoft\.com\.$/,
    );
  });

  it("says the sign-in was cancelled", async () => {
    microsoft.device({ decline: true });

    expect((await failure(signIn())).message).toBe("Sign-in cancelled.");
    expect(await connections()).toHaveLength(0);
  });

  it("says the code expired and how to fix a single-tenant app", async () => {
    microsoft.device({ expire: true });

    expect((await failure(signIn())).message).toBe(
      "The code expired before it was approved. Run the command again. If Microsoft said the app isn't multi-tenant, add --tenant <Directory (tenant) ID> from the app's Overview.",
    );
  });

  it("says a personal account needs --scopes outlook,calendar when Microsoft refuses the permissions", async () => {
    microsoft.device({ invalidScope: true });

    expect((await failure(signIn())).message).toMatch(/^Microsoft didn't allow some of the permissions \(AADSTS70011: .*\)\. With a personal account, run it with --scopes outlook,calendar: Teams needs a work or school account\.$/);
  });

  it("says how to allow public client flows", async () => {
    await microsoft.close();
    microsoft = await fakeMicrosoft({ clientSecret: "web-secret" });

    expect((await failure(signIn())).message).toBe(
      `Microsoft didn't let the app sign in without a secret. In your app registration, open Authentication, set "Allow public client flows" to Yes and click Save.`,
    );
  });

  it("passes other failures on", async () => {
    microsoft.fail("POST /token", 400, { body: { error: "server_error", error_description: "AADSTS90000: Something broke.\r\nTrace ID: x" } });

    expect((await failure(signIn())).message).toBe("Microsoft sign-in failed (AADSTS90000: Something broke).");
  });
});
