import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GraphApi, GraphApiError, MicrosoftAuthError, withTokens } from "@jev-events/microsoft";
import { needsSignIn } from "jev-events";

import { isFatal } from "../src/api.js";
import { fakeMicrosoft, type FakeMicrosoft } from "./fake-microsoft.js";

let microsoft: FakeMicrosoft;

beforeEach(async () => {
  microsoft = await fakeMicrosoft();
});

afterEach(async () => {
  await microsoft.close();
});

/** A client signed in to the fake Microsoft, with retries that barely wait. */
function api(): GraphApi {
  return new GraphApi(withTokens(microsoft.tokens()), { retryBaseMs: 1 });
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("Expected it to fail.");
    },
    (error: unknown) => error,
  );
}

describe("GraphApi", () => {
  it("sends the token, the query without undefined values, immutable ids and a JSON body", async () => {
    const client = api();

    const me = await client.call<{ id: string; mail: string }>("GET", "/me", { query: { $select: "id,mail", $top: undefined } });
    await client.call("POST", "/me/mailFolders", { body: { displayName: "Receipts" }, prefer: ['outlook.body-content-type="text"'] });

    expect(me).toEqual({ id: "user-me", mail: "me@acme.com" });
    const [get, post] = microsoft.requests;
    expect(get).toMatchObject({ api: "graph", path: "/me", token: "access-1", query: { $select: "id,mail" }, prefer: 'IdType="ImmutableId"' });
    expect(post).toMatchObject({ body: { displayName: "Receipts" }, prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' });
  });

  it("returns undefined for an empty response", async () => {
    microsoft.addEvent({ id: "AAMkEv1=", organizer: "Ann Lee <ann@example.com>" });

    expect(await api().call("POST", "/me/events/AAMkEv1=/accept", { body: { sendResponse: true } })).toBeUndefined();
  });

  it("refreshes an expired token once and retries with the new one", async () => {
    const client = api();
    microsoft.expireAccessTokens();

    await client.call("GET", "/me");

    expect(microsoft.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /me", "POST /token", "GET /me"]);
    expect(microsoft.calls("GET /me").map((r) => r.token)).toEqual(["access-1", "access-2"]);
  });

  it("gives up when the refreshed token is refused too, as a sign-in problem", async () => {
    microsoft.fail("GET /me", 401, { times: Infinity });

    const error = await failure(api().call("GET", "/me"));

    expect(error).toBeInstanceOf(GraphApiError);
    expect((error as GraphApiError).status).toBe(401);
    expect(needsSignIn(error)).toBe(true);
    expect(isFatal(error)).toBe(true);
    expect(microsoft.calls("POST /token")).toHaveLength(1);
  });

  it("reports a revoked sign-in as a MicrosoftAuthError", async () => {
    const client = api();
    microsoft.revoke();

    const error = await failure(client.call("GET", "/me"));

    expect(error).toBeInstanceOf(MicrosoftAuthError);
    expect(needsSignIn(error)).toBe(true);
    expect(isFatal(error)).toBe(true);
  });

  it("waits and retries when throttled, then succeeds", async () => {
    microsoft.fail("GET /me", 429, { times: 2 });

    await api().call("GET", "/me");

    expect(microsoft.calls("GET /me")).toHaveLength(3);
  });

  it("retries an outage three times, then gives up with Microsoft's message", async () => {
    microsoft.fail("GET /me", 503, { times: Infinity, headers: {} });

    const error = await failure(api().call("GET", "/me"));

    expect(microsoft.calls("GET /me")).toHaveLength(4);
    expect(error).toBeInstanceOf(GraphApiError);
    expect((error as GraphApiError).message).toBe("Microsoft GET /me failed (503): The service is temporarily unavailable.");
    expect(isFatal(error)).toBe(false);
  });

  it("treats a missing permission as needing to sign in again", async () => {
    const client = new GraphApi(withTokens({ ...microsoft.tokens(), accessToken: microsoft.connection({ scopes: ["User.Read", "Mail.ReadWrite"] }).credentials.accessToken as string }));

    const error = (await failure(client.call("GET", "/me/chats"))) as GraphApiError;

    expect(error.status).toBe(403);
    expect(error.needsSignIn).toBe(true);
    expect(error.message).toMatch(/Missing scope permissions.* Sign in again and allow every permission Microsoft asks for\.$/);
    expect(isFatal(error)).toBe(true);
  });

  it("doesn't treat other refusals as sign-in problems", async () => {
    microsoft.fail("GET /me", 403, { body: { error: { code: "ErrorQuotaExceeded", message: "The mailbox is full." } } });

    const error = (await failure(api().call("GET", "/me"))) as GraphApiError;

    expect(error.code).toBe("ErrorQuotaExceeded");
    expect(error.needsSignIn).toBe(false);
  });

  it("follows next links for every page, and refuses links anywhere else", async () => {
    for (const name of ["A", "B", "C", "D", "E"]) microsoft.addFolder(name);
    const client = api();

    const folders = await client.all<{ displayName: string }>("/me/mailFolders", { query: { $top: 1000 } });
    const pages = await client.all<{ id: string }>("/me/mailFolders/inbox/messages", { query: { $top: 1 } }, 2);
    const refused = await failure(client.call("GET", "https://evil.example.com/v1.0/me"));

    expect(folders.map((f) => f.displayName)).toContain("E");
    expect(pages).toEqual([]);
    expect((refused as Error).message).toBe(`Refusing to send the Microsoft token to https://evil.example.com: links must point to ${microsoft.url}/v1.0.`);
  });

  it("stops after maxPages", async () => {
    for (let i = 0; i < 5; i++) microsoft.deliver({ from: `sender${i}@example.com`, subject: `Email ${i}` });

    const items = await api().all<{ id: string }>("/me/mailFolders/inbox/messages", { query: { $top: 2 } }, 2);

    expect(items).toHaveLength(4);
    expect(microsoft.calls("GET /me/mailFolders/inbox/messages")).toHaveLength(2);
    expect(microsoft.calls("GET /me/mailFolders/inbox/messages")[1]?.query).toMatchObject({ $top: "2", $skip: "2" });
  });
});
