import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { expandScopes, fromEnv, MicrosoftAuthError, withTokens, type MicrosoftTokens } from "@jev-events/microsoft";
import { needsSignIn } from "jev-events";

import { fakeMicrosoft, type FakeMicrosoft } from "./fake-microsoft.js";

let microsoft: FakeMicrosoft;

beforeEach(async () => {
  microsoft = await fakeMicrosoft();
});

afterEach(async () => {
  await microsoft.close();
});

async function failure(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("Expected it to fail.");
    },
    (error: unknown) => error as Error,
  );
}

describe("withTokens", () => {
  it("uses the access token while it's fresh", async () => {
    const auth = withTokens(microsoft.tokens());

    expect(await auth.token()).toBe("access-1");
    expect(auth.email).toBe("me@acme.com");
    expect(microsoft.calls("POST /token")).toHaveLength(0);
  });

  it("refreshes shortly before expiry, asking for the same permissions, and keeps the new refresh token", async () => {
    const saved: MicrosoftTokens[] = [];
    const auth = withTokens({ ...microsoft.tokens(), expiresAt: Date.now() + 30_000 }, (tokens) => void saved.push(tokens));

    const token = await auth.token();
    await auth.refresh();

    expect(token).toBe("access-2");
    const [first, second] = microsoft.calls("POST /token");
    expect(first?.tenant).toBe("common");
    expect(first?.body).toMatchObject({ client_id: microsoft.clientId, grant_type: "refresh_token", refresh_token: "refresh-1" });
    expect((first?.body as { scope: string }).scope.split(" ")).toEqual(expect.arrayContaining(["Mail.ReadWrite", "Chat.ReadWrite", "offline_access"]));
    expect(first?.body).not.toHaveProperty("client_secret");
    expect(second?.body).toMatchObject({ refresh_token: "refresh-2" });
    expect(saved.map((tokens) => tokens.refreshToken)).toEqual(["refresh-2", "refresh-3"]);
    expect(saved[0]?.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
  });

  it("refreshes once for callers that ask at the same time", async () => {
    const auth = withTokens({ ...microsoft.tokens(), accessToken: undefined });

    const tokens = await Promise.all([auth.token(), auth.token(), auth.refresh()]);

    expect(new Set(tokens).size).toBe(1);
    expect(microsoft.calls("POST /token")).toHaveLength(1);
  });

  it("refreshes against the saved tenant", async () => {
    await withTokens({ ...microsoft.tokens(), tenant: "contoso.onmicrosoft.com" }).refresh();

    expect(microsoft.calls("POST /token")[0]?.tenant).toBe("contoso.onmicrosoft.com");
  });

  it("says the account has to sign in again when the refresh token stopped working", async () => {
    const auth = withTokens(microsoft.tokens());
    microsoft.revoke();

    const error = await failure(auth.refresh());

    expect(error).toBeInstanceOf(MicrosoftAuthError);
    expect(needsSignIn(error)).toBe(true);
    expect(error.message).toBe("Microsoft signed this account out: the sign-in expired, the password changed or access was revoked.");
  });

  it("says how to allow public client flows when the app refuses to sign in without a secret", async () => {
    await microsoft.close();
    microsoft = await fakeMicrosoft({ clientSecret: "web-secret" });

    const error = await failure(withTokens({ ...microsoft.tokens(), clientSecret: undefined }).refresh());

    expect(error.message).toBe(
      `Microsoft didn't accept the app ${microsoft.clientId} (invalid_client). In your app registration, open Authentication, set "Allow public client flows" to Yes and click Save.`,
    );
    expect(needsSignIn(error)).toBe(false);
  });

  it("sends a web app's secret, and says when it's wrong", async () => {
    await microsoft.close();
    microsoft = await fakeMicrosoft({ clientSecret: "web-secret" });

    await withTokens(microsoft.tokens()).refresh();
    const error = await failure(withTokens({ ...microsoft.tokens(), clientSecret: "old-secret" }).refresh());

    expect(microsoft.calls("POST /token")[0]?.body).toMatchObject({ client_secret: "web-secret" });
    expect(error.message).toBe(`Microsoft didn't accept the app ${microsoft.clientId} (invalid_client). Check its client secret, which may have expired.`);
  });

  it("says what went wrong on other failures", async () => {
    microsoft.fail("POST /token", 503);

    const error = await failure(withTokens(microsoft.tokens()).refresh());

    expect(error.message).toBe("Couldn't refresh the Microsoft token (503 temporarily_unavailable).");
  });

  it("needs a client ID and a token", () => {
    expect(() => withTokens({ clientId: "", refreshToken: "r" })).toThrow("Microsoft auth needs a clientId and an access or refresh token.");
    expect(() => withTokens({ clientId: "c" })).toThrow("Microsoft auth needs a clientId and an access or refresh token.");
  });
});

describe("fromEnv", () => {
  it("builds a connection from the environment", () => {
    const connection = fromEnv({ MICROSOFT_CLIENT_ID: "client", MICROSOFT_REFRESH_TOKEN: "refresh", MICROSOFT_TENANT: "contoso.onmicrosoft.com" });

    expect(connection).toMatchObject({
      id: "microsoft:env",
      integration: "microsoft",
      label: "MICROSOFT_REFRESH_TOKEN",
      credentials: { clientId: "client", refreshToken: "refresh", tenant: "contoso.onmicrosoft.com" },
    });
    expect(connection.credentials).not.toHaveProperty("clientSecret");
  });

  it("says what to set when it's missing", () => {
    expect(() => fromEnv({ MICROSOFT_CLIENT_ID: "client" })).toThrow("Set MICROSOFT_CLIENT_ID and MICROSOFT_REFRESH_TOKEN.");
  });
});

describe("expandScopes", () => {
  it("turns short names into Graph permissions and keeps the rest", () => {
    expect(expandScopes(["outlook", "calendar", "teams", "Files.Read", "outlook"])).toEqual(["Mail.ReadWrite", "Calendars.ReadWrite", "Chat.ReadWrite", "Files.Read"]);
  });
});
