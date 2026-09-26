import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GoogleApi, GoogleApiError, GoogleAuthError, withTokens } from "@jev-events/google";

import { isFatal } from "../src/api.js";
import { fakeGoogle, googleError, type FakeGoogle } from "./fake-google.js";

let google: FakeGoogle;

beforeEach(async () => {
  google = await fakeGoogle();
});

afterEach(async () => {
  await google.close();
});

/** A client signed in to the fake Google, with retries that barely wait. */
function api(retryBaseMs = 1): GoogleApi {
  return new GoogleApi(withTokens(google.tokens()), { retryBaseMs });
}

async function failure(promise: Promise<unknown>): Promise<GoogleApiError> {
  const error = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(error instanceof GoogleApiError)) throw new Error(`Expected a GoogleApiError, got ${String(error)}`);
  return error;
}

describe("GoogleApi", () => {
  it("sends the token, the query without undefined values, and a JSON body", async () => {
    const client = api();

    const profile = await client.gmail<{ emailAddress: string }>("GET", "/profile", {
      query: { fields: "emailAddress", maxResults: 5, includeSpamTrash: false, pageToken: undefined },
    });
    await client.gmail("POST", "/labels", { body: { name: "Jev" } });

    expect(profile.emailAddress).toBe("me@acme.com");
    const [get, post] = google.requests;
    expect(get).toMatchObject({ api: "gmail", token: "access-1", query: { fields: "emailAddress", maxResults: "5", includeSpamTrash: "false" } });
    expect(get?.query).not.toHaveProperty("pageToken");
    expect(post?.body).toEqual({ name: "Jev" });
    expect(google.labels().map((label) => label.name)).toContain("Jev");
  });

  it("calls the Calendar API", async () => {
    const calendar = await api().calendar<{ id: string; timeZone: string }>("GET", "/calendars/primary");

    expect(calendar).toMatchObject({ id: "me@acme.com", timeZone: "Europe/Stockholm" });
    expect(google.requests[0]?.api).toBe("calendar");
  });

  it("returns undefined for an empty response", async () => {
    google.fail("GET /profile", 204, { body: "" });

    expect(await api().gmail("GET", "/profile")).toBeUndefined();
  });

  it("refreshes an expired token once and retries with the new one", async () => {
    const client = api();
    google.expireAccessTokens();

    await client.gmail("GET", "/profile");

    expect(google.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /profile", "POST /token", "GET /profile"]);
    expect(google.calls("GET /profile").map((r) => r.token)).toEqual(["access-1", "access-2"]);
  });

  it("gives up when the refreshed token is refused too", async () => {
    google.fail("GET /profile", 401, { times: Infinity });

    const error = await failure(api().gmail("GET", "/profile"));

    expect(error.status).toBe(401);
    expect(isFatal(error)).toBe(true);
    expect(google.calls("POST /token")).toHaveLength(1);
    expect(google.calls("GET /profile")).toHaveLength(2);
  });

  it("stops with a GoogleAuthError when the sign-in was revoked", async () => {
    const client = api();
    google.expireAccessTokens();
    google.revoke();

    const error = await client.gmail("GET", "/profile").catch((error: unknown) => error);

    expect(error).toBeInstanceOf(GoogleAuthError);
    expect(isFatal(error)).toBe(true);
  });

  it.each([429, 500, 503])("retries a %i and then succeeds", async (status) => {
    google.fail("GET /profile", status, { times: 2 });

    await api().gmail("GET", "/profile");

    expect(google.calls("GET /profile")).toHaveLength(3);
  });

  it("retries a rate limit that Google sends as a 403", async () => {
    google.fail("GET /profile", 403, {
      times: 4,
      body: googleError(403, "User Rate Limit Exceeded", "userRateLimitExceeded", "PERMISSION_DENIED", "usageLimits"),
    });

    const error = await failure(api().gmail("GET", "/profile"));

    expect(google.calls("GET /profile")).toHaveLength(4);
    expect(error.reason).toBe("userRateLimitExceeded");
    expect(error.rateLimited).toBe(true);
    expect(isFatal(error)).toBe(false);
  });

  it("gives up after three retries", async () => {
    google.fail("GET /profile", 503, { times: Infinity });

    const error = await failure(api().gmail("GET", "/profile"));

    expect(google.calls("GET /profile")).toHaveLength(4);
    expect(error.message).toBe("Google GET /profile failed (503): Backend Error");
    expect(isFatal(error)).toBe(false);
  });

  it("explains a missing permission and doesn't retry it", async () => {
    google.fail("GET /profile", 403);

    const error = await failure(api().gmail("GET", "/profile"));

    expect(error.message).toBe(
      "Google GET /profile failed (403): Request had insufficient authentication scopes. Sign in again and tick every box on Google's consent screen: npx jev-events auth google",
    );
    expect(error.reason).toBe("insufficientPermissions");
    expect(isFatal(error)).toBe(true);
    expect(google.calls("GET /profile")).toHaveLength(1);
  });

  it("keeps an error body that isn't JSON as text", async () => {
    google.fail("GET /profile", 400, { body: "<html>Bad request</html>" });

    const error = await failure(api().gmail("GET", "/profile"));

    expect(error.message).toBe("Google GET /profile failed (400): <html>Bad request</html>");
    expect(error.body).toBe("<html>Bad request</html>");
    expect(error.reason).toBeUndefined();
  });

  it("backs off exponentially when Google doesn't say how long to wait", async () => {
    google.fail("GET /profile", 503, { times: 2, headers: {} });
    const started = Date.now();

    await api(20).gmail("GET", "/profile");

    // 20ms, then 40ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  it("waits as long as Retry-After says", async () => {
    google.fail("GET /profile", 429, { headers: { "Retry-After": "0.05" } });
    const started = Date.now();

    // Without Retry-After this would wait 10 seconds and time out.
    await api(10_000).gmail("GET", "/profile");

    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });
});

describe("isFatal", () => {
  const error = (status: number, body?: unknown) => new GoogleApiError("GET", "/profile", status, body);

  it.each<[string, boolean, unknown]>([
    ["a lost sign-in", true, new GoogleAuthError("Signed out.")],
    ["a refused token", true, error(401)],
    ["a missing permission", true, error(403, googleError(403, "Insufficient Permission", "insufficientPermissions", "PERMISSION_DENIED"))],
    ["a disabled API", true, error(403, googleError(403, "Gmail API has not been used in project 1", "accessNotConfigured", "PERMISSION_DENIED", "usageLimits"))],
    ["a rate limit sent as a 403", false, error(403, googleError(403, "Rate Limit Exceeded", "rateLimitExceeded", "PERMISSION_DENIED", "usageLimits"))],
    ["a quota error without reasons", false, error(403, { error: { message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } })],
    ["a 429", false, error(429)],
    ["an outage", false, error(503)],
    ["a missing message", false, error(404)],
    ["a network error", false, new Error("socket hang up")],
  ])("%s → %s", (_name, fatal, value) => {
    expect(isFatal(value)).toBe(fatal);
  });
});
