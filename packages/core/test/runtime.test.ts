import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  memoryStore,
  monitor,
  noul,
  runtime,
  SignInError,
  silentLogger,
  storeKey,
  type App,
  type ConnectedSource,
  type ConnectOptions,
  type ErrorEvent,
  type Item,
  type Logger,
  type NewConnection,
  type OAuthFlow,
  type Runtime,
  type RuntimeOptions,
  type SourceContext,
} from "../src/index.js";
import { mockJev } from "../src/testing.js";
import { flush, inboxSource, testConnection } from "./helpers.js";

const urgent = noul("Does this need a reply today?");
const BASE = "https://example.com/api/jev";

const started: Runtime[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((jev) => jev.stop()));
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** A runtime that is stopped after the test. */
function track(jev: Runtime): Runtime {
  started.push(jev);
  return jev;
}

const client = () => mockJev(() => ({ urgent: 0.1 }));

const inbox = (source = inboxSource()) => monitor({ source, questions: { urgent }, client: client(), log: silentLogger });

function capture(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const write = (message: string) => {
    lines.push(message);
  };
  return { lines, debug() {}, info: write, warn: write, error: write };
}

async function read(response: Response): Promise<{ status: number; body: unknown }> {
  return { status: response.status, body: await response.json() };
}

function cron(secret?: string): Request {
  return new Request(`${BASE}/cron`, secret === undefined ? {} : { headers: { authorization: `Bearer ${secret}` } });
}

function post(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface Session {
  token: string;
}

/** A source that only receives webhooks, like Slack's Events API. */
function eventsSource(
  overrides: Partial<ConnectedSource<Item, "test", Session>> = {},
): ConnectedSource<Item, "test", Session> {
  return {
    id: "test:events",
    platform: "test",
    integration: "test",
    noun: "message",
    session: ({ connection }) => ({ token: String(connection?.credentials.token) }),
    async receive(request, ctx) {
      const posted = (await request.json()) as { account: string; id: string; text: string };
      const connection = (await ctx.connections()).find((c) => c.label === posted.account);
      // Providers retry anything but a 2xx, so accounts nobody reads still get one.
      if (!connection) return new Response("ignored");
      await ctx.emit(connection, { id: posted.id, text: posted.text, at: new Date() });
      return Response.json({ ok: true });
    },
    ...overrides,
  };
}

interface ChatSource extends ConnectedSource<Item, "test", Session> {
  /** Streams that are connected now, by connection id. */
  readonly live: Map<string, SourceContext<Item, Session>>;
  /** Each stream start, as "<connection id> <token>". */
  readonly starts: string[];
  say(connectionId: string, text: string): void;
}

/** A live stream per connection, like Twitch chat. */
function chatSource(): ChatSource {
  const live = new Map<string, SourceContext<Item, Session>>();
  const starts: string[] = [];
  let count = 0;
  return {
    id: "test:chat",
    platform: "test",
    integration: "test",
    noun: "message",
    live,
    starts,
    session: ({ connection }) => ({ token: String(connection?.credentials.token) }),
    start(ctx) {
      const id = ctx.connection?.id ?? "-";
      starts.push(`${id} ${ctx.session.token}`);
      live.set(id, ctx);
      ctx.signal.addEventListener("abort", () => {
        if (live.get(id) === ctx) live.delete(id);
      });
    },
    say(connectionId, text) {
      const ctx = live.get(connectionId);
      if (!ctx) throw new Error(`${connectionId} isn't streaming.`);
      void ctx.emit({ id: `c${++count}`, text, at: new Date() });
    },
  };
}

const ANN: NewConnection = {
  account: "ann@acme.com",
  label: "Ann",
  credentials: { token: "token-c0de" },
  facts: { timeZone: "Europe/Stockholm" },
};

/** An OAuth app whose provider signs everyone in as Ann. */
function testApp(complete: OAuthFlow["complete"] = async ({ code }) => ({ ...ANN, credentials: { token: `token-${code}` } })): App {
  return {
    integration: "test",
    oauth: {
      authorizeUrl({ redirectUri, state, codeChallenge, scopes }) {
        const query = new URLSearchParams({
          redirect_uri: redirectUri,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: ["read", ...(scopes ?? [])].join(" "),
        });
        return `https://accounts.example/authorize?${query.toString()}`;
      },
      complete,
    },
  };
}

describe("runtime", () => {
  it("needs a store and monitors with ids of their own", async () => {
    const store = memoryStore();
    expect(() => runtime({ monitors: [inbox()] } as unknown as RuntimeOptions)).toThrow(
      "runtime() needs a store, such as postgresStore(pool) or fileStore().",
    );
    expect(() => runtime({ store } as unknown as RuntimeOptions)).toThrow("runtime() needs monitors: [monitor({ ... })].");
    expect(() => runtime({ monitors: [inbox(), inbox()], store })).toThrow(
      'Two monitors have the id "test:inbox". Give one of them its own id with monitor({ id: … }).',
    );
    expect(() => runtime({ monitors: [{ id: "mine" } as never], store })).toThrow("Pass monitors created with monitor().");

    const shared = inbox();
    runtime({ monitors: [shared], store });
    expect(() => runtime({ monitors: [shared], store })).toThrow(
      'The monitor "test:inbox" already belongs to a runtime. Create a separate monitor for each runtime.',
    );
    await expect(shared.run({ store })).rejects.toThrow(
      "This monitor belongs to a runtime. Start it with runtime.start(), or check it with runtime.check().",
    );
  });

  it("stops its monitors, saves the store, and can't be started again", async () => {
    const store = memoryStore();
    const save = vi.fn(async () => {});
    const jev = runtime({ monitors: [inbox()], store: { ...store, flush: save }, log: silentLogger });
    await jev.stop();
    expect(save).toHaveBeenCalledTimes(1);
    await expect(jev.start()).rejects.toThrow("A stopped runtime can't be restarted. Create a new one with runtime().");
    await expect(jev.check()).rejects.toThrow("A stopped runtime can't be restarted.");
  });

  it("fails fast when Jev isn't set up", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const log = capture();
    const events = monitor({ source: eventsSource(), questions: { urgent }, log: silentLogger });
    const jev = runtime({ monitors: [events], store: memoryStore(), log });

    await expect(jev.start()).rejects.toThrow(/No API key was provided/);
    expect(await read(await jev.handle(post("/webhook/test", {})))).toEqual({
      status: 500,
      body: { error: "Jev Events isn't set up. Check the server logs." },
    });
    expect(log.lines).toEqual(["couldn't get ready for a webhook:"]);
  });
});

describe("cron route", () => {
  it("only runs checks for your scheduler", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const unset = runtime({ monitors: [inbox()], store: memoryStore(), log: silentLogger });
    expect(await read(await unset.handle(cron("anything")))).toEqual({
      status: 500,
      body: { error: "Set CRON_SECRET so only your scheduler can run checks." },
    });

    const jev = runtime({ monitors: [inbox()], store: memoryStore(), cronSecret: "s3cret", log: silentLogger });
    const basic = new Request(`${BASE}/cron`, { headers: { authorization: "Basic s3cret" } });
    for (const request of [cron(), cron("wrong"), basic]) {
      expect(await read(await jev.handle(request))).toEqual({
        status: 401,
        body: { error: "Send Authorization: Bearer <CRON_SECRET> to run checks." },
      });
    }
    const ok = await jev.handle(cron("s3cret"));
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await read(ok)).toEqual({
      status: 200,
      body: { checked: 0, skipped: 0, failed: 0, monitors: { "test:inbox": { received: 0, judged: 0, errors: 0 } } },
    });

    vi.stubEnv("CRON_SECRET", "from-env");
    const fromEnv = runtime({ monitors: [inbox()], store: memoryStore(), log: silentLogger });
    expect((await fromEnv.handle(new Request(`${BASE}/cron/`, { headers: { authorization: "Bearer from-env" } }))).status).toBe(200);
  });

  it("checks each connection that is due, and skips ones checked less than `every` ago", async () => {
    let clock = Date.parse("2026-09-26T12:00:00Z");
    const now = () => clock;
    const ann = testConnection("ann");
    const bob = testConnection("bob");
    const source = inboxSource();
    source.deliver(ann.id, "can we move the call?");
    source.deliver(ann.id, "lunch?");
    source.deliver(bob.id, "invoice attached");
    const judged: string[] = [];
    const mail = inbox(source).on("judged", (e) => {
      judged.push(`${e.connection.label}: ${e.item.text}`);
    });
    const jev = runtime({ monitors: [mail], store: memoryStore({ now }), connections: [ann, bob], log: silentLogger, now });

    expect(await jev.check()).toEqual({
      checked: 2,
      skipped: 0,
      failed: 0,
      monitors: { "test:inbox": { received: 3, judged: 3, errors: 0 } },
    });
    expect(judged.sort()).toEqual(["ann: can we move the call?", "ann: lunch?", "bob: invoice attached"]);

    source.deliver(ann.id, "one more thing");
    expect(await jev.check()).toMatchObject({ checked: 0, skipped: 2, monitors: { "test:inbox": { received: 0 } } });

    clock += 60_000;
    expect(await jev.check()).toMatchObject({ checked: 2, skipped: 0, monitors: { "test:inbox": { received: 1, judged: 1 } } });
    expect(judged).toContain("ann: one more thing");
  });

  it("keeps checking the other connections when one fails", async () => {
    let clock = Date.parse("2026-09-26T12:00:00Z");
    const now = () => clock;
    const store = memoryStore({ now });
    const [ann, bob, cat] = ["ann", "bob", "cat"].map((name) => testConnection(name)) as [
      ReturnType<typeof testConnection>,
      ReturnType<typeof testConnection>,
      ReturnType<typeof testConnection>,
    ];
    const source = inboxSource();
    const flaky: typeof source = {
      ...source,
      async check(ctx) {
        if (ctx.connection?.id === bob.id) throw new Error("503 Service Unavailable");
        if (ctx.connection?.id === cat.id) throw new SignInError("Google revoked access");
        return source.check?.(ctx);
      },
    };
    source.deliver(ann.id, "still here");
    const errors: ErrorEvent[] = [];
    const mail = inbox(flaky).on("error", (e) => {
      errors.push(e);
    });
    const jev = runtime({ monitors: [mail], store, connections: [ann, bob, cat], log: silentLogger, now });

    expect(await jev.check()).toEqual({
      checked: 1,
      skipped: 0,
      failed: 2,
      monitors: { "test:inbox": { received: 1, judged: 1, errors: 2 } },
    });
    expect(errors.map((e) => [e.connection?.id, String(e.error), e.fatal, e.needsSignIn])).toEqual(
      expect.arrayContaining([
        [bob.id, "Error: 503 Service Unavailable", undefined, undefined],
        [cat.id, "SignInError: Google revoked access", true, true],
      ]),
    );
    expect(errors.every((e) => !("credentials" in (e.connection ?? {})))).toBe(true);
    expect(await store.connections.get(bob.id)).toMatchObject({ status: "active" });
    expect(await store.connections.get(cat.id)).toMatchObject({ status: "needs-sign-in", problem: "Google revoked access" });

    clock += 60_000;
    expect(await jev.check()).toMatchObject({ checked: 1, failed: 1 });
  });

  it("reports checks that run past maxDurationMs, and leaves the rest for the next run", async () => {
    vi.useFakeTimers();
    const people = ["a", "b", "c", "d", "e"].map((name) => testConnection(name));
    // Hangs until the run stops, like a provider that never answers.
    const source = inboxSource({
      check: (ctx) => new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve())),
    });
    const errors: string[] = [];
    const mail = inbox(source).on("error", (e) => {
      errors.push(`${e.connection?.label}: ${String(e.error)}`);
    });
    const jev = runtime({ monitors: [mail], store: memoryStore(), connections: people, maxDurationMs: 5_000, log: silentLogger });

    const result = jev.check();
    await vi.advanceTimersByTimeAsync(5_000);
    // Four at once; the fifth would start after the deadline.
    expect(await result).toEqual({
      checked: 0,
      skipped: 1,
      failed: 4,
      monitors: { "test:inbox": { received: 0, judged: 0, errors: 4 } },
    });
    expect(errors.sort()).toEqual(
      ["a", "b", "c", "d"].map((name) => `${name}: Error: Checking took longer than 5000ms. Raise maxDurationMs, or check less at once.`),
    );
  });

  it("never checks a connection twice at once, even from two processes", async () => {
    let clock = Date.parse("2026-09-26T12:00:00Z");
    const store = memoryStore({ now: () => clock });
    const ann = testConnection("ann");
    let release = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    let checks = 0;
    const source = inboxSource({
      async check() {
        checks++;
        await slow;
      },
    });
    const process = () => runtime({ monitors: [inbox(source)], store, connections: [ann], log: silentLogger });
    const first = process();
    const second = process();

    const running = first.check();
    await flush();
    expect(checks).toBe(1);
    // Due again, but the first process is still checking.
    clock += 55_000;
    expect(await second.check()).toMatchObject({ checked: 0, skipped: 1 });

    release();
    expect(await running).toMatchObject({ checked: 1 });
    clock += 55_000;
    expect(await second.check()).toMatchObject({ checked: 1 });
    expect(checks).toBe(2);
  });
});

describe("webhook route", () => {
  it("judges what a webhook brings in for the connection it's about, once", async () => {
    const ann = testConnection("ann");
    const bob = testConnection("bob");
    const judged: string[] = [];
    const events = monitor({ source: eventsSource(), questions: { urgent }, client: client(), log: silentLogger }).on("judged", (e) => {
      judged.push(`${e.connection.label}: ${e.item.text}`);
    });
    const jev = runtime({ monitors: [events], store: memoryStore(), connections: [ann, bob], log: silentLogger });

    expect(await read(await jev.handle(post("/webhook/test", { account: "bob", id: "1", text: "the server is down" })))).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(judged).toEqual(["bob: the server is down"]);

    // Providers deliver again when they aren't sure it arrived.
    await jev.handle(post("/webhook/test", { account: "bob", id: "1", text: "the server is down" }));
    expect(judged).toHaveLength(1);
    expect(jev.stats()["test:events"]).toMatchObject({ received: 2, judged: 1, dropped: { duplicate: 1 } });

    const ignored = await jev.handle(post("/webhook/test", { account: "nobody", id: "2", text: "hi" }));
    expect([ignored.status, await ignored.text()]).toEqual([200, "ignored"]);
  });

  it("builds the session from the connection's saved tokens", async () => {
    const ann = testConnection("ann");
    const seen: unknown[] = [];
    const source = eventsSource({
      async receive(_request, ctx) {
        const [connection] = await ctx.connections();
        if (!connection) throw new Error("no connection");
        seen.push(connection, await ctx.session(connection));
        return new Response(null, { status: 204 });
      },
    });
    const jev = runtime({
      monitors: [monitor({ source, questions: { urgent }, client: client(), log: silentLogger })],
      store: memoryStore(),
      connections: [ann],
      log: silentLogger,
    });

    expect((await jev.handle(post("/webhook/test", {}))).status).toBe(204);
    expect(seen).toEqual([expect.objectContaining({ id: ann.id, label: "ann" }), { token: "token-ann" }]);
    expect(seen[0]).not.toHaveProperty("credentials");
  });

  it("answers first and judges afterwards when given waitUntil", async () => {
    let answer = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const slow = mockJev(async () => {
      await answered;
      return { urgent: 0.9 };
    });
    const later: Promise<unknown>[] = [];
    const judged: string[] = [];
    const events = monitor({ source: eventsSource(), questions: { urgent }, client: slow, log: silentLogger }).on("judged", (e) => {
      judged.push(e.item.text);
    });
    const jev = runtime({
      monitors: [events],
      store: memoryStore(),
      connections: [testConnection("ann")],
      waitUntil: (promise) => later.push(promise),
      log: silentLogger,
    });

    const response = await jev.handle(post("/webhook/test", { account: "ann", id: "1", text: "are you coming?" }));
    expect(response.status).toBe(200);
    expect(judged).toEqual([]);
    answer();
    await Promise.all(later);
    expect(judged).toEqual(["are you coming?"]);
  });

  it("reports a webhook it couldn't handle", async () => {
    const errors: ErrorEvent[] = [];
    const source = eventsSource({
      async receive() {
        throw new Error("Malformed signature header");
      },
    });
    const events = monitor({ source, questions: { urgent }, client: client(), log: silentLogger }).on("error", (e) => {
      errors.push(e);
    });
    const jev = runtime({ monitors: [events], store: memoryStore(), log: silentLogger });

    expect(await read(await jev.handle(post("/webhook/test", {})))).toEqual({ status: 500, body: { error: "Couldn't handle this webhook." } });
    expect(errors.map((e) => [e.phase, String(e.error)])).toEqual([["source", "Error: Malformed signature header"]]);
  });

  it("reports once when a webhook is for a connection that was removed", async () => {
    const errors: string[] = [];
    const source = eventsSource({
      async receive(_request, ctx) {
        const gone = { id: "test:gone", integration: "test", label: "gone" };
        await ctx.emit(gone, { id: "1", text: "one", at: new Date() });
        await ctx.emit(gone, { id: "2", text: "two", at: new Date() });
        return new Response(null, { status: 204 });
      },
    });
    const events = monitor({ source, questions: { urgent }, client: client(), log: silentLogger }).on("error", (e) => {
      errors.push(String(e.error));
    });
    const jev = runtime({ monitors: [events], store: memoryStore(), log: silentLogger });

    expect((await jev.handle(post("/webhook/test", {}))).status).toBe(204);
    expect(errors).toEqual(["Error: The connection gone doesn't exist any more."]);
  });

  it("answers 404 for routes and webhooks it doesn't know", async () => {
    const events = monitor({ source: eventsSource(), questions: { urgent }, client: client(), log: silentLogger });
    const jev = runtime({ monitors: [events], store: memoryStore(), log: silentLogger });
    const notFound = {
      status: 404,
      body: { error: "Not found. Jev Events handles /cron, /webhook/<integration>, /callback/<integration> and /connect/<integration>." },
    };

    expect(await read(await jev.handle(post("/webhook/slack", {})))).toEqual({
      status: 404,
      body: { error: 'No monitor receives webhooks for "slack".' },
    });
    expect(await read(await jev.handle(new Request(`${BASE}/elsewhere`)))).toEqual(notFound);
    expect(await read(await jev.handle(new Request(`${BASE}/webhook/%E0%A4%A`)))).toEqual(notFound);
  });
});

describe("sign-in", () => {
  it("connects an account through the provider's consent page", async () => {
    const store = memoryStore();
    const verifiers: string[] = [];
    const app = testApp(async ({ code, codeVerifier, redirectUri }) => {
      verifiers.push(codeVerifier);
      expect(redirectUri).toBe(`${BASE}/callback/test`);
      return { ...ANN, credentials: { token: `token-${code}` } };
    });
    const jev = runtime({ monitors: [inbox()], store, apps: [app], baseUrl: BASE, log: silentLogger });

    const consent = new URL(await jev.connectUrl("test", { userId: "u1", returnTo: "/settings#accounts", scopes: ["calendar"] }));
    expect(`${consent.origin}${consent.pathname}`).toBe("https://accounts.example/authorize");
    expect(consent.searchParams.get("redirect_uri")).toBe(`${BASE}/callback/test`);
    expect(consent.searchParams.get("scope")).toBe("read calendar");
    const state = consent.searchParams.get("state");

    const done = await jev.handle(new Request(`${BASE}/callback/test?code=c0de&state=${state}`));
    expect([done.status, done.headers.get("location")]).toEqual([302, "/settings?connected=test#accounts"]);
    expect(createHash("sha256").update(verifiers[0] ?? "").digest("base64url")).toBe(consent.searchParams.get("code_challenge"));
    expect(await store.connections.list()).toEqual([
      expect.objectContaining({
        id: "test:u1:ann@acme.com",
        integration: "test",
        userId: "u1",
        label: "Ann",
        credentials: { token: "token-c0de" },
        facts: { timeZone: "Europe/Stockholm" },
        status: "active",
      }),
    ]);

    // A sign-in link works once.
    const again = await jev.handle(new Request(`${BASE}/callback/test?code=c0de&state=${state}`));
    expect([again.status, await again.text()]).toEqual([400, expect.stringContaining("This sign-in link expired. Start again.")]);
  });

  it("sends people back when they cancel, and says when signing in failed", async () => {
    let clock = Date.parse("2026-09-26T12:00:00Z");
    const now = () => clock;
    const app = testApp(async () => {
      throw new Error("invalid_grant");
    });
    const jev = runtime({ monitors: [inbox()], store: memoryStore({ now }), apps: [app], baseUrl: BASE, log: silentLogger, now });
    const stateFor = async (options?: ConnectOptions) => new URL(await jev.connectUrl("test", options)).searchParams.get("state");
    const callback = (query: string, integration = "test") => jev.handle(new Request(`${BASE}/callback/${integration}?${query}`));

    const cancelled = await callback(`error=access_denied&state=${await stateFor({ returnTo: "/settings?tab=accounts" })}`);
    expect([cancelled.status, cancelled.headers.get("location")]).toEqual([302, "/settings?tab=accounts&connect_error=cancelled"]);
    const cancelledPage = await callback(`error=access_denied&state=${await stateFor()}`);
    expect([cancelledPage.status, await cancelledPage.text()]).toEqual([400, expect.stringContaining("Sign-in was cancelled.")]);

    const failed = await callback(`code=c0de&state=${await stateFor({ returnTo: "/settings" })}`);
    expect([failed.status, failed.headers.get("location")]).toEqual([302, "/settings?connect_error=failed"]);
    const failedPage = await callback(`code=c0de&state=${await stateFor()}`);
    expect([failedPage.status, await failedPage.text()]).toEqual([502, expect.stringContaining("Couldn&#39;t finish signing in: invalid_grant")]);

    const elsewhere = await stateFor();
    expect((await callback(`code=c0de&state=${elsewhere}`, "slack")).status).toBe(400);
    expect((await callback("code=c0de")).status).toBe(400);
    const expired = await stateFor();
    clock += 10 * 60_000;
    expect((await callback(`code=c0de&state=${expired}`)).status).toBe(400);
  });

  it("won't make a connect link it couldn't finish", async () => {
    vi.stubEnv("JEV_EVENTS_URL", "");
    const noBase = runtime({ monitors: [inbox()], store: memoryStore(), apps: [testApp()], log: silentLogger });
    await expect(noBase.connectUrl("slack")).rejects.toThrow("No app registered for slack. Pass runtime({ apps: [slack.app({ ... })] }).");
    await expect(noBase.connectUrl("test")).rejects.toThrow(
      "Set baseUrl (or JEV_EVENTS_URL) to where jev.handle is mounted, such as https://example.com/api/jev.",
    );

    const bot = runtime({ monitors: [inbox()], store: memoryStore(), apps: [{ integration: "test" }], baseUrl: BASE, log: silentLogger });
    await expect(bot.connectUrl("test")).rejects.toThrow(
      "The test app has no sign-in flow. Save a connection with runtime.connect() instead.",
    );

    const jev = runtime({ monitors: [inbox()], store: memoryStore(), apps: [testApp()], baseUrl: BASE, log: silentLogger });
    for (const returnTo of ["https://evil.example/", "//evil.example", "/\\evil.example", "settings"]) {
      await expect(jev.connectUrl("test", { returnTo })).rejects.toThrow(
        new TypeError("returnTo must be a path on your site, such as /settings."),
      );
    }

    vi.stubEnv("JEV_EVENTS_URL", "https://app.example/api/jev/");
    const fromEnv = runtime({ monitors: [inbox()], store: memoryStore(), apps: [testApp()], log: silentLogger });
    expect(new URL(await fromEnv.connectUrl("test")).searchParams.get("redirect_uri")).toBe("https://app.example/api/jev/callback/test");
  });

  it("sends people signed in to your product to the provider from /connect/<integration>", async () => {
    vi.stubEnv("JEV_EVENTS_URL", "");
    const off = runtime({ monitors: [inbox()], store: memoryStore(), apps: [testApp()], log: silentLogger });
    expect(await read(await off.handle(new Request(`${BASE}/connect/test`)))).toEqual({
      status: 404,
      body: { error: "Sign-in links are off. Pass signIn: { user } to runtime() to turn them on, or call jev.connectUrl() from your own route." },
    });

    const jev = runtime({
      monitors: [inbox()],
      store: memoryStore(),
      apps: [testApp()],
      signIn: { user: (request) => request.headers.get("x-user") ?? undefined },
      log: silentLogger,
    });
    const as = (user: string, path: string) => jev.handle(new Request(`${BASE}${path}`, { headers: { "x-user": user } }));
    const finish = (consent: URL) =>
      jev.handle(new Request(`${BASE}/callback/test?code=c0de&state=${consent.searchParams.get("state")}`));

    expect(await read(await jev.handle(new Request(`${BASE}/connect/test`)))).toEqual({
      status: 401,
      body: { error: "Sign in to your account first." },
    });

    const start = await as("u1", "/connect/test?returnTo=/settings");
    expect(start.status).toBe(302);
    const consent = new URL(start.headers.get("location") ?? "");
    // Without baseUrl, the callback is next to where the route is mounted.
    expect(consent.searchParams.get("redirect_uri")).toBe(`${BASE}/callback/test`);
    expect((await finish(consent)).headers.get("location")).toBe("/settings?connected=test");
    expect(await jev.store.connections.get("test:u1:ann@acme.com")).toMatchObject({ userId: "u1", label: "Ann" });

    // A returnTo on another site is left out.
    const elsewhere = new URL((await as("u2", "/connect/test?returnTo=https://evil.example")).headers.get("location") ?? "");
    const page = await finish(elsewhere);
    expect([page.status, await page.text()]).toEqual([200, expect.stringContaining("Connected Ann. You can close this tab.")]);
    expect(await jev.store.connections.get("test:u2:ann@acme.com")).toMatchObject({ userId: "u2" });

    expect(await read(await as("u1", "/connect/slack"))).toEqual({
      status: 400,
      body: { error: "No app registered for slack. Pass runtime({ apps: [slack.app({ ... })] })." },
    });
  });
});

describe("worker", () => {
  it("streams each connection, and follows connections as they're added, changed and removed", async () => {
    const store = memoryStore();
    const ann = testConnection("ann");
    const bob = testConnection("bob");
    const source = chatSource();
    const judged: string[] = [];
    const chat = monitor({ source, questions: { urgent }, client: client(), log: silentLogger }).on("judged", (e) => {
      judged.push(`${e.connection.label}: ${e.item.text}`);
    });
    const jev = track(runtime({ monitors: [chat], store, connections: [ann], log: silentLogger }));

    await jev.start();
    await flush();
    expect(source.starts).toEqual([`${ann.id} token-ann`]);
    source.say(ann.id, "hello");
    await chat.idle();
    expect(judged).toEqual(["ann: hello"]);

    await jev.connect(bob);
    await flush();
    expect(source.starts).toEqual([`${ann.id} token-ann`, `${bob.id} token-bob`]);

    // Signing in again starts the stream over with the new tokens.
    await jev.connect({ ...bob, credentials: { token: "fresh" } });
    await flush();
    expect(source.starts.at(-1)).toBe(`${bob.id} fresh`);
    expect([...source.live.keys()].sort()).toEqual([ann.id, bob.id]);

    await store.set(storeKey("cursor", "test:chat", ann.id), "somewhere");
    await jev.disconnect(ann.id);
    await flush();
    expect([...source.live.keys()]).toEqual([bob.id]);
    expect(await store.connections.get(ann.id)).toBeUndefined();
    expect(await store.get(storeKey("cursor", "test:chat", ann.id))).toBeUndefined();
    expect(jev.stats()["test:chat"]).toMatchObject({ received: 1, judged: 1, running: 1 });
  });

  it("picks up connections saved or paused elsewhere within 30 seconds", async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const ann = testConnection("ann");
    const source = chatSource();
    const jev = track(
      runtime({ monitors: [monitor({ source, questions: { urgent }, client: client(), log: silentLogger })], store, log: silentLogger }),
    );
    await jev.start();

    // The web app saved a sign-in; the worker hasn't looked yet.
    await store.connections.save(ann);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(source.starts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(source.starts).toEqual([`${ann.id} token-ann`]);

    await store.connections.update(ann.id, { status: "paused" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(source.live.size).toBe(0);
  });

  it("starts a stream again after it fails, waiting longer each time", async () => {
    vi.useFakeTimers();
    const log = capture();
    const ann = testConnection("ann");
    const source = chatSource();
    const chat = monitor({ source, questions: { urgent }, client: client(), log: silentLogger });
    const jev = track(runtime({ monitors: [chat], store: memoryStore(), connections: [ann], log }));
    const drop = () => source.live.get(ann.id)?.fail(new Error("socket closed"), { fatal: true });

    await jev.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(source.starts).toHaveLength(1);

    drop();
    await vi.advanceTimersByTimeAsync(999);
    expect(source.starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(source.starts).toHaveLength(2);

    drop();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(source.starts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(source.starts).toHaveLength(3);

    // A stream that stayed up for a minute starts its backoff over.
    await vi.advanceTimersByTimeAsync(60_000);
    drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(source.starts).toHaveLength(4);
    expect(log.lines.filter((line) => line.startsWith("starting"))).toEqual([
      "starting test:chat for ann again in 1s",
      "starting test:chat for ann again in 2s",
      "starting test:chat for ann again in 1s",
    ]);
  });

  it("leaves a connection that needs a new sign-in until the user signs in again", async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const ann = testConnection("ann");
    const source = chatSource();
    const errors: ErrorEvent[] = [];
    const chat = monitor({ source, questions: { urgent }, client: client(), log: silentLogger }).on("error", (e) => {
      errors.push(e);
    });
    const jev = track(runtime({ monitors: [chat], store, connections: [ann], log: silentLogger }));
    await jev.start();
    await vi.advanceTimersByTimeAsync(0);

    source.live.get(ann.id)?.fail(new SignInError("Token revoked"));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(source.starts).toHaveLength(1);
    expect(await store.connections.get(ann.id)).toMatchObject({ status: "needs-sign-in", problem: "Token revoked" });
    expect(errors).toMatchObject([{ phase: "source", fatal: true, needsSignIn: true, connection: { id: ann.id } }]);

    await jev.connect({ ...ann, credentials: { token: "fresh" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(source.starts.at(-1)).toBe(`${ann.id} fresh`);
    const saved = await store.connections.get(ann.id);
    expect(saved).toMatchObject({ status: "active" });
    expect(saved).not.toHaveProperty("problem");
  });

  it("checks polling sources every `every`, and less often while they fail", async () => {
    vi.useFakeTimers();
    const ann = testConnection("ann");
    const source = inboxSource();
    const began = Date.now();
    const times: number[] = [];
    let failing = false;
    const flaky: typeof source = {
      ...source,
      async check(ctx) {
        times.push((Date.now() - began) / 1000);
        if (failing) throw new Error("503 Service Unavailable");
        return source.check?.(ctx);
      },
    };
    const judged: string[] = [];
    const mail = monitor({ source: flaky, questions: { urgent }, every: "10s", client: client(), log: silentLogger })
      .on("judged", (e) => {
        judged.push(e.item.text);
      })
      .on("error", () => {});
    const jev = track(runtime({ monitors: [mail], store: memoryStore(), connections: [ann], log: silentLogger }));

    await jev.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(times).toEqual([0]);

    source.deliver(ann.id, "new mail");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(times).toEqual([0, 10]);
    expect(judged).toEqual(["new mail"]);

    failing = true;
    await vi.advanceTimersByTimeAsync(80_000);
    // Fails at 20s, then waits 10s, 20s and 40s.
    expect(times).toEqual([0, 10, 20, 30, 50, 90]);

    failing = false;
    await vi.advanceTimersByTimeAsync(90_000);
    // Waits 80s after the fourth failure, then every 10s again.
    expect(times).toEqual([0, 10, 20, 30, 50, 90, 170, 180]);
  });

  it("checks each connection once per `every`, even with two workers sharing a store", async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const ann = testConnection("ann");
    const source = inboxSource();
    source.deliver(ann.id, "hello");
    const judged: string[] = [];
    const worker = () =>
      track(
        runtime({
          monitors: [
            inbox(source).on("judged", (e) => {
              judged.push(e.item.text);
            }),
          ],
          store,
          connections: [ann],
          log: silentLogger,
        }),
      );

    await Promise.all([worker().start(), worker().start()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.checks).toEqual([ann.id]);
    expect(judged).toEqual(["hello"]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(source.checks).toEqual([ann.id, ann.id]);
  });

  it("says when a monitor has nothing to read yet", async () => {
    const log = capture();
    const events = monitor({ source: eventsSource(), questions: { urgent }, client: client(), log: silentLogger });
    const jev = track(runtime({ monitors: [events, inbox()], store: memoryStore(), log }));

    await jev.start();
    expect(log.lines).toEqual([
      "test:events only receives webhooks, so the worker has nothing to read. Mount jev.handle in your web app so the platform can reach /webhook/test.",
      "No test connections yet. Users connect through /connect/test, or save one with runtime.connect().",
    ]);
  });
});
