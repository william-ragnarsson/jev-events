import { afterEach, describe, expect, it, vi } from "vitest";

import {
  choice,
  DailyBudget,
  defineAction,
  from,
  memoryStore,
  monitor,
  noul,
  score,
  SignInError,
  silentLogger,
  type ActionEvent,
  type DroppedEvent,
  type ErrorEvent,
  type Item,
  type JudgedEvent,
  type ReviewEvent,
  type Source,
} from "../src/index.js";
import { mockJev } from "../src/testing.js";
import { flush, inboxSource, manualSource, testConnection } from "./helpers.js";

const kind = choice("What is this chat message?", { question: null, hateful: null, other: null });
const hateful = noul("Is this message hateful?");
const severity = score("How severe is it?", ["none", "mild", "bad", "severe"]);
const urgent = noul("Does this email need a reply today?");

const textOf = (state: unknown) => JSON.stringify(state);

afterEach(() => {
  vi.useRealTimers();
});

describe("monitor", () => {
  it("judges every item and emits judged events with typed answers", async () => {
    const jev = mockJev(({ state }) => ({ kind: textOf(state).includes("?") ? "question" : "other" }));
    const judged: Array<[string, string]> = [];
    const stats = await monitor({ source: from(["when is the next stream?", "gg"]), questions: { kind }, client: jev, log: silentLogger })
      .on("judged", (e) => {
        judged.push([e.item.text, e.answers.kind.choice]);
      })
      .run();

    expect(judged).toEqual([
      ["when is the next stream?", "question"],
      ["gg", "other"],
    ]);
    expect(stats).toMatchObject({ received: 2, judged: 2, usage: { inputTokens: 200, outputTokens: 0 } });
    expect(stats.estimatedCostUsd).toBeCloseTo((200 / 1_000_000) * 0.042);
  });

  it("fires choice outcomes when the label is chosen, or when its probability reaches min", async () => {
    const jev = mockJev(() => ({ kind: { question: 0.3, hateful: 0.45, other: 0.25 } }));
    const chosen = vi.fn();
    const strict = vi.fn();
    const loose = vi.fn();
    await monitor({ source: from(["x"]), questions: { kind }, client: jev, log: silentLogger })
      .on("kind:hateful", chosen)
      .on("kind:hateful", { min: 0.9 }, strict)
      .on("kind:question", { min: 0.25 }, loose)
      .run();

    expect(chosen).toHaveBeenCalledOnce();
    expect(chosen.mock.calls[0]?.[0].trigger).toMatchObject({ event: "kind:hateful", label: "hateful", probability: 0.45 });
    expect(strict).not.toHaveBeenCalled();
    expect(loose).toHaveBeenCalledOnce();
  });

  it("fires noul outcomes at 0.5 by default and sends the uncertain band to review", async () => {
    const jev = mockJev(({ state }) => ({ hateful: Number(textOf(state).match(/p(\d\.\d+)/)?.[1]) }));
    const fired = vi.fn();
    const reviews: ReviewEvent[] = [];
    const banned: string[] = [];
    await monitor({ source: from(["p0.95", "p0.6", "p0.3"]), questions: { hateful }, client: jev, log: silentLogger })
      .on("hateful", fired)
      .on("hateful", { min: 0.9, review: 0.5 }, function banHammer(e) {
        banned.push(e.item.text);
      })
      .on("review", (e) => {
        reviews.push(e);
      })
      .run();

    expect(fired.mock.calls.map((call) => call[0].item.text)).toEqual(["p0.95", "p0.6"]);
    expect(banned).toEqual(["p0.95"]);
    expect(reviews.map((e) => [e.item.text, e.handler])).toEqual([["p0.6", "banHammer"]]);
  });

  it("fires score outcomes from the middle of the rubric by default", async () => {
    const jev = mockJev(({ state }) => ({ severity: Number(textOf(state).match(/s(\d(?:\.\d+)?)/)?.[1]) }));
    const midpoint = vi.fn();
    const severe = vi.fn();
    await monitor({ source: from(["s0.4", "s1.5", "s2.9"]), questions: { severity }, client: jev, log: silentLogger })
      .on("severity", midpoint)
      .on("severity", { atLeast: 2.5 }, severe)
      .run();

    expect(midpoint.mock.calls.map((call) => call[0].item.text)).toEqual(["s1.5", "s2.9"]);
    expect(severe.mock.calls.map((call) => call[0].trigger.score)).toEqual([2.9]);
  });

  it("rejects unknown events and mismatched policies with helpful errors", () => {
    const chat = monitor({ source: manualSource(), questions: { kind, hateful, severity }, client: mockJev(() => ({})) });
    // @ts-expect-error unknown label
    expect(() => chat.on("kind:spam", () => {})).toThrow(/Valid events: kind:question, kind:hateful, kind:other, hateful, severity/);
    // @ts-expect-error a choice question needs a label
    expect(() => chat.on("kind", () => {})).toThrow(/choice question/);
    // @ts-expect-error nouls have no labels
    expect(() => chat.on("hateful:yes", () => {})).toThrow(/noul question/);
    expect(() => chat.on("hateful", { min: 1.5 }, () => {})).toThrow(RangeError);
    // @ts-expect-error scores use atLeast
    expect(() => chat.on("severity", { min: 0.5 }, () => {})).toThrow(/atLeast/);
    expect(() => chat.on("severity", { atLeast: 9 }, () => {})).toThrow(RangeError);
  });

  it("rejects reserved or malformed question ids", () => {
    expect(() => monitor({ source: manualSource(), questions: { judged: hateful } })).toThrow(/reserved/);
    expect(() => monitor({ source: manualSource(), questions: { "a:b": hateful } })).toThrow(/can't contain/);
    expect(() => monitor({ source: manualSource(), questions: {} })).toThrow(/at least one question/);
  });

  it("rejects sources and options it can't run", () => {
    // @ts-expect-error a source is required
    expect(() => monitor({ questions: { hateful } })).toThrow(/needs a source/);
    expect(() => monitor({ source: { id: "test:nothing", platform: "test" }, questions: { hateful } })).toThrow(/can't deliver items/);
    expect(() => monitor({ source: manualSource(), questions: { hateful }, every: 0 })).toThrow(RangeError);

    const ban = defineAction({ platform: "twitch", name: "twitch.ban", describe: () => "ban", run: async () => {} });
    const chat = monitor({ source: manualSource(), questions: { hateful } });
    // @ts-expect-error a twitch action can't handle a test source
    expect(() => chat.on("hateful", ban)).toThrow(/twitch\.ban is a twitch action, but test:manual is a test source/);
  });

  it("won't run() while it is started, or after it stopped", async () => {
    const chat = monitor({ source: manualSource(), questions: { hateful }, client: mockJev(() => ({})), log: silentLogger });
    await chat.start();
    await expect(chat.run()).rejects.toThrow(/already running/);
    await chat.stop();
    await expect(chat.run()).rejects.toThrow(/can't be restarted/);
  });

  it("won't run() a source that only receives webhooks", async () => {
    const source: Source<Item, "test"> = {
      id: "test:push",
      platform: "test",
      receive: async () => new Response(null, { status: 202 }),
    };
    await expect(monitor({ source, questions: { hateful }, client: mockJev(() => ({})) }).run()).rejects.toThrow(/only receives webhooks/);
  });
});

describe("native actions", () => {
  const timeout = defineAction({
    platform: "*",
    name: "test.timeout",
    describe: (e) => `timeout ${e.item.author?.name ?? "someone"}`,
    run: vi.fn(async () => {}),
  });

  it("only logs in dry-run, which is the default", async () => {
    const info = vi.fn();
    const actions: ActionEvent[] = [];
    await monitor({
      source: from([{ text: "you idiot", author: "viewer1" }]),
      questions: { hateful },
      client: mockJev(() => ({ hateful: 0.93 })),
      log: { ...silentLogger, info },
    })
      .on("hateful", timeout)
      .on("action", (e) => {
        actions.push(e);
      })
      .run();

    expect(actions.map((e) => [e.status, e.description])).toEqual([["dry-run", "timeout viewer1"]]);
    expect(info).toHaveBeenCalledWith("[dry-run] would timeout viewer1 (hateful p=0.93)");
  });

  it("runs when armed, but never against protected users", async () => {
    const run = vi.fn(async () => {});
    const act = defineAction({ platform: "test", name: "test.ban", describe: () => "ban", run });
    const source = manualSource({ isProtected: (item) => item.author?.roles?.includes("moderator") ?? false });
    const actions: ActionEvent[] = [];
    const chat = monitor({ source, questions: { hateful }, client: mockJev(() => ({ hateful: 0.99 })), dryRun: false, log: silentLogger })
      .on("hateful", act)
      .on("action", (e) => {
        actions.push(e);
      });
    await chat.start();
    source.push("bad", { author: { id: "1", name: "viewer" } });
    source.push("bad", { author: { id: "2", name: "mod", roles: ["moderator"] } });
    await chat.idle();
    await chat.stop();

    expect(run).toHaveBeenCalledOnce();
    expect(actions.map((e) => [e.event.item.author?.name, e.status, e.reason])).toEqual(
      expect.arrayContaining([
        ["viewer", "done", undefined],
        ["mod", "skipped", "protected user"],
      ]),
    );
    expect(chat.stats().actions).toMatchObject({ done: 1, skipped: 1 });
  });

  it("says why an item is protected when the source gives a reason", async () => {
    const act = defineAction({ platform: "test", name: "test.trash", describe: () => "trash", run: async () => {} });
    const source = manualSource({ isProtected: (item) => (item.author?.name.endsWith("@acme.com") ? "colleague at acme.com" : false) });
    const actions: ActionEvent[] = [];
    const judged: boolean[] = [];
    const mail = monitor({ source, questions: { hateful }, client: mockJev(() => ({ hateful: 0.99 })), dryRun: false, log: silentLogger })
      .on("hateful", act)
      .on("judged", (e) => {
        judged.push(e.protected);
      })
      .on("action", (e) => {
        actions.push(e);
      });
    await mail.start();
    source.push("spam", { author: { id: "1", name: "ann@acme.com" } });
    await mail.idle();
    await mail.stop();

    expect(judged).toEqual([true]);
    expect(actions.map((e) => [e.status, e.reason, e.event.protectedBecause])).toEqual([["skipped", "colleague at acme.com", "colleague at acme.com"]]);
  });

  it("protects what the monitor's protect() says, on top of the source", async () => {
    const run = vi.fn(async () => {});
    const act = defineAction({ platform: "test", name: "test.trash", describe: () => "trash", run });
    const source = manualSource();
    const actions: Array<[string, string, string | undefined]> = [];
    const mail = monitor({
      source,
      questions: { hateful },
      client: mockJev(() => ({ hateful: 0.99 })),
      dryRun: false,
      protect: (item) => (item.author?.name === "biggest customer" ? "a customer" : false),
      log: silentLogger,
    })
      .on("hateful", act)
      .on("action", (e) => {
        actions.push([e.event.item.author?.name ?? "", e.status, e.reason]);
      });
    await mail.start();
    source.push("angry", { author: { id: "1", name: "biggest customer" } });
    source.push("spam", { author: { id: "2", name: "spammer" } });
    await mail.idle();
    await mail.stop();

    expect(run).toHaveBeenCalledOnce();
    expect(actions).toEqual(
      expect.arrayContaining([
        ["biggest customer", "skipped", "a customer"],
        ["spammer", "done", undefined],
      ]),
    );
  });

  it("treats an item as protected when checking throws", async () => {
    const run = vi.fn(async () => {});
    const act = defineAction({ platform: "test", name: "test.trash", describe: () => "trash", run });
    const source = manualSource({
      isProtected: () => {
        throw new Error("contacts API is down");
      },
    });
    const actions: ActionEvent[] = [];
    const mail = monitor({ source, questions: { hateful }, client: mockJev(() => ({ hateful: 0.99 })), dryRun: false, log: silentLogger })
      .on("hateful", act)
      .on("action", (e) => {
        actions.push(e);
      });
    await mail.start();
    source.push("spam");
    await mail.idle();
    await mail.stop();

    expect(run).not.toHaveBeenCalled();
    expect(actions.map((e) => [e.status, e.reason])).toEqual([["skipped", "couldn't check whether the item is protected"]]);
  });

  it("refuses to arm actions on a source that can't act", async () => {
    const chat = monitor({ source: manualSource({ canAct: false }), questions: { hateful }, client: mockJev(() => ({})), dryRun: false }).on(
      "hateful",
      timeout,
    );
    await expect(chat.start()).rejects.toThrow(/isn't authenticated/);
  });

  it("reports failed actions as action and error events", async () => {
    const broken = defineAction({
      platform: "*",
      name: "test.broken",
      describe: () => "break",
      run: async () => {
        throw new Error("403 forbidden");
      },
    });
    const errors: ErrorEvent[] = [];
    const actions: ActionEvent[] = [];
    await monitor({ source: from(["x"]), questions: { hateful }, client: mockJev(() => ({ hateful: 1 })), dryRun: false, log: silentLogger })
      .on("hateful", broken)
      .on("action", (e) => {
        actions.push(e);
      })
      .on("error", (e) => {
        errors.push(e);
      })
      .run();

    expect(actions[0]).toMatchObject({ status: "failed", reason: "403 forbidden" });
    expect(errors[0]?.phase).toBe("action");
  });

  it("runs an action at most once per item, even for two monitors sharing a store", async () => {
    const store = memoryStore();
    const run = vi.fn(async () => {});
    const flag = defineAction({ platform: "*", name: "test.flag", describe: () => "flag", run });
    const actions: Array<[string, string | undefined]> = [];
    for (let i = 0; i < 2; i++) {
      await monitor({
        id: "flagger",
        source: from([{ id: "x1", text: "bad" }]),
        questions: { hateful },
        client: mockJev(() => ({ hateful: 0.99 })),
        dryRun: false,
        log: silentLogger,
      })
        .on("hateful", flag)
        .on("action", (e) => {
          actions.push([e.status, e.reason]);
        })
        .run({ store });
    }

    expect(run).toHaveBeenCalledOnce();
    expect(actions).toEqual([
      ["done", undefined],
      ["skipped", "already ran for this item"],
    ]);
  });
});

describe("pipeline", () => {
  it("drops filtered items before they cost anything", async () => {
    const jev = mockJev(() => ({ hateful: 0 }));
    const dropped: DroppedEvent[] = [];
    await monitor({
      source: from(["!command", "hello"]),
      questions: { hateful },
      client: jev,
      filter: (item) => !item.text.startsWith("!"),
      log: silentLogger,
    })
      .on("dropped", (e) => {
        dropped.push(e);
      })
      .run();

    expect(jev.calls).toHaveLength(1);
    expect(dropped.map((e) => [e.item.text, e.reason])).toEqual([["!command", "filtered"]]);
  });

  it("drops repeats of an item a live stream sends twice", async () => {
    const jev = mockJev(() => ({ hateful: 0 }));
    const source = manualSource();
    const dropped: string[] = [];
    const chat = monitor({ source, questions: { hateful }, client: jev, log: silentLogger }).on("dropped", (e) => {
      dropped.push(`${e.item.text}:${e.reason}`);
    });
    await chat.start();
    source.push("hello", { id: "same" });
    source.push("hello again", { id: "same" });
    await chat.idle();
    await chat.stop();

    expect(jev.calls).toHaveLength(1);
    expect(dropped).toEqual(["hello again:duplicate"]);
  });

  it("limits requests per second and drops the oldest items when the queue overflows", async () => {
    vi.useFakeTimers();
    const jev = mockJev(() => ({ hateful: 0 }));
    const source = manualSource();
    const dropped: string[] = [];
    const chat = monitor({
      source,
      questions: { hateful },
      client: jev,
      rate: { perSecond: 2, burst: 2 },
      maxQueue: 3,
      log: silentLogger,
    }).on("dropped", (e) => {
      dropped.push(`${e.item.text}:${e.reason}`);
    });
    await chat.start();
    for (const text of ["a", "b", "c", "d", "e", "f", "g"]) source.push(text);

    await vi.advanceTimersByTimeAsync(0);
    expect(jev.calls).toHaveLength(2);
    expect(dropped).toEqual(["c:overflow", "d:overflow"]);

    await vi.advanceTimersByTimeAsync(1_600);
    expect(jev.calls).toHaveLength(5);
    await chat.stop();
  });

  it("drops items that waited longer than maxLagMs", async () => {
    vi.useFakeTimers();
    const jev = mockJev(() => ({ hateful: 0 }));
    const source = manualSource();
    const dropped: string[] = [];
    const chat = monitor({
      source,
      questions: { hateful },
      client: jev,
      rate: { perSecond: 1, burst: 1 },
      maxLagMs: 1_500,
      log: silentLogger,
    }).on("dropped", (e) => {
      dropped.push(`${e.item.text}:${e.reason}`);
    });
    await chat.start();
    for (const text of ["a", "b", "c", "d"]) source.push(text);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(jev.calls.map((call) => textOf(call.state))).toEqual([expect.stringContaining('"a"'), expect.stringContaining('"b"')]);
    expect(dropped).toEqual(["c:stale", "d:stale"]);
    await chat.stop();
  });

  it("reuses answers for identical text when caching is on", async () => {
    const jev = mockJev(() => ({ hateful: 0.9 }), { latencyMs: 5 });
    const judged: JudgedEvent[] = [];
    await monitor({ source: from(["BUY FOLLOWERS", "buy   followers", "hi"]), questions: { hateful }, client: jev, cache: true, log: silentLogger })
      .on("judged", (e) => {
        judged.push(e);
      })
      .run();

    expect(jev.calls).toHaveLength(2);
    expect(judged.map((e) => [e.item.text, e.cached])).toEqual(
      expect.arrayContaining([
        ["BUY FOLLOWERS", false],
        ["buy   followers", true],
        ["hi", false],
      ]),
    );
  });

  it("stops judging once the daily token budget is spent", async () => {
    const jev = mockJev(() => ({ hateful: 0 }), { inputTokens: 600 });
    const dropped: string[] = [];
    const stats = await monitor({
      source: from(["a", "b", "c"]),
      questions: { hateful },
      client: jev,
      budget: { inputTokensPerDay: 1_000 },
      rate: { concurrency: 1 },
      log: silentLogger,
    })
      .on("dropped", (e) => {
        dropped.push(e.reason);
      })
      .run();

    expect(stats.judged).toBeLessThan(3);
    expect(dropped).toContain("budget");
  });

  it("keeps the daily budget in the store, so the next run knows what was spent", async () => {
    const store = memoryStore();
    const options = {
      id: "budgeted",
      questions: { hateful },
      client: mockJev(() => ({ hateful: 0 }), { inputTokens: 600 }),
      budget: { inputTokensPerDay: 1_000 },
      rate: { concurrency: 1 },
      log: silentLogger,
    };
    const first = await monitor({ ...options, source: from(["a"]) }).run({ store });
    const second = await monitor({ ...options, source: from(["b", "c"]) }).run({ store });

    expect(first.judged).toBe(1);
    expect(second.judged).toBe(1);
    expect(second.dropped.budget).toBe(1);
  });

  it("shares one DailyBudget between monitors", async () => {
    const budget = new DailyBudget(1_000);
    const jev = mockJev(() => ({ hateful: 0 }), { inputTokens: 600 });
    const options = { questions: { hateful }, client: jev, budget, rate: { concurrency: 1 }, log: silentLogger };
    const first = await monitor({ ...options, source: from(["a"]) }).run();
    expect(first.judged).toBe(1);
    expect(budget).toMatchObject({ spent: 600, remaining: 400, exhausted: false });

    const second = await monitor({ ...options, source: from(["b", "c"]) }).run();
    expect(second.judged).toBe(1);
    expect(second.dropped.budget).toBe(1);
    expect(budget.exhausted).toBe(true);
  });

  it("surfaces judge and handler errors without stopping the stream", async () => {
    let calls = 0;
    const jev = mockJev(() => {
      if (++calls === 1) throw new Error("529 overloaded");
      return { hateful: 0.99 };
    });
    const errors: string[] = [];
    const stats = await monitor({ source: from(["a", "b"]), questions: { hateful }, client: jev, rate: { concurrency: 1 }, log: silentLogger })
      .on("hateful", () => {
        throw new Error("handler bug");
      })
      .on("error", (e) => {
        errors.push(`${e.phase}:${(e.error as Error).message}`);
      })
      .run();

    expect(errors).toEqual(["judge:529 overloaded", "handler:handler bug"]);
    expect(stats.errors).toBe(2);
    expect(stats.judged).toBe(1);
  });

  it("drops queued items on stop and runs plugin cleanups", async () => {
    vi.useFakeTimers();
    const source = manualSource();
    const cleanup = vi.fn();
    const dropped: string[] = [];
    const chat = monitor({
      source,
      questions: { hateful },
      client: mockJev(() => ({ hateful: 0 })),
      rate: { perSecond: 1, burst: 1 },
      log: silentLogger,
    })
      .use(() => cleanup)
      .on("dropped", (e) => {
        dropped.push(e.reason);
      });
    await chat.start();
    source.push("a");
    source.push("b");
    await vi.advanceTimersByTimeAsync(0);
    await chat.stop();

    expect(dropped).toEqual(["stopped"]);
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(chat.start()).rejects.toThrow(/can't be restarted/);
  });
});

describe("state", () => {
  it("sends the item alone when there is no context", async () => {
    const jev = mockJev(() => ({ hateful: 0 }));
    await monitor({ source: from([{ text: "hello", author: "ann" }], { noun: "message" }), questions: { hateful }, client: jev, log: silentLogger }).run();

    expect(jev.calls[0]?.state).toEqual({ message: { text: "hello", author: "ann" } });
    expect(jev.calls[0]?.questions.hateful?.instructions).toBe("Is this message hateful?");
  });

  it("adds recent items and facts as context, and points questions at the item", async () => {
    const jev = mockJev(() => ({ hateful: 0 }));
    const source = manualSource({ defaults: { recent: 2 } });
    const chat = monitor({
      source,
      questions: { hateful },
      client: jev,
      context: { about: { channel: "speedruns", rules: ["no spoilers"] } },
      log: silentLogger,
    });
    await chat.start();
    source.push("one", { author: { id: "1", name: "a" } });
    source.push("two", { author: { id: "2", name: "b" } });
    source.push("three", { author: { id: "3", name: "c", roles: ["vip"] }, facts: { firstMessage: true } });
    await chat.idle();
    await chat.stop();

    expect(jev.calls[2]?.state).toEqual({
      message: { firstMessage: true, text: "three", author: "c", roles: ["vip"] },
      recent: [
        { author: "a", text: "one" },
        { author: "b", text: "two" },
      ],
      about: { channel: "speedruns", rules: ["no spoilers"] },
    });
    expect(jev.calls[2]?.questions.hateful?.instructions).toEqual({ question: "Is this message hateful?", inspect: "message" });
  });

  it("uses a custom state builder when given", async () => {
    const jev = mockJev(() => ({ hateful: 0 }));
    await monitor({
      source: from<Item | string>(["hi"]),
      questions: { hateful },
      client: jev,
      state: (item) => ({ chat_line: item.text }),
      log: silentLogger,
    }).run();

    expect(jev.calls[0]?.state).toEqual({ chat_line: "hi" });
    expect(jev.calls[0]?.questions.hateful?.instructions).toBe("Is this message hateful?");
  });

  it("adds the connection's profile to what Jev sees", async () => {
    const store = memoryStore();
    const ann = testConnection("ann", { userId: "u1" });
    const source = inboxSource();
    source.deliver(ann.id, "Lunch on Friday?");
    const jev = mockJev(() => ({ urgent: 0 }));
    const connections: unknown[] = [];
    await monitor({
      source,
      questions: { urgent },
      client: jev,
      profile: (connection) => ({ plan: "pro", user: connection.userId ?? null }),
      log: silentLogger,
    })
      .on("judged", (e) => {
        connections.push(e.connection);
      })
      .run({ store, connections: [ann] });

    expect(jev.calls[0]?.state).toEqual({ email: { text: "Lunch on Friday?" }, profile: { plan: "pro", user: "u1" } });
    expect(jev.calls[0]?.questions.urgent?.instructions).toEqual({ question: "Does this email need a reply today?", inspect: "email" });
    expect(connections).toEqual([expect.objectContaining({ id: ann.id, label: "ann", userId: "u1" })]);
    expect(connections[0]).not.toHaveProperty("credentials");
  });
});

describe("connections", () => {
  it("checks each connection from its own cursor", async () => {
    const store = memoryStore();
    const ann = testConnection("ann");
    const bob = testConnection("bob");
    const source = inboxSource();
    source.deliver(ann.id, "for ann");
    source.deliver(bob.id, "for bob");
    const judged: Array<[string, string]> = [];
    const inbox = () =>
      monitor({ source, questions: { urgent }, client: mockJev(() => ({ urgent: 0 })), log: silentLogger }).on("judged", (e) => {
        judged.push([e.item.text, e.connection.id]);
      });

    await inbox().run({ store, connections: [ann, bob] });
    expect(judged).toHaveLength(2);
    expect(judged).toEqual(
      expect.arrayContaining([
        ["for ann", ann.id],
        ["for bob", bob.id],
      ]),
    );

    judged.length = 0;
    source.deliver(ann.id, "second");
    const stats = await inbox().run({ store });
    expect(judged).toEqual([["second", ann.id]]);
    expect(stats.received).toBe(1);
  });

  it("doesn't judge an item twice when a check reads it again", async () => {
    const store = memoryStore();
    const items: Item[] = [
      { id: "a", text: "one", at: new Date() },
      { id: "b", text: "two", at: new Date() },
    ];
    // Never saves a cursor, so every check reads everything again.
    const source: Source<Item, "test"> = {
      id: "test:again",
      platform: "test",
      async check(ctx) {
        for (const item of items) await ctx.emit(item);
      },
    };
    const options = { source, questions: { hateful }, log: silentLogger };
    const first = await monitor({ ...options, client: mockJev(() => ({ hateful: 0 })) }).run({ store });
    const second = await monitor({ ...options, client: mockJev(() => ({ hateful: 0 })) }).run({ store });

    expect(first.judged).toBe(2);
    expect(second).toMatchObject({ received: 2, judged: 0, dropped: { duplicate: 2 } });
  });

  it("marks a connection whose access was revoked, and keeps reading the others", async () => {
    const store = memoryStore();
    const ann = testConnection("ann");
    const bob = testConnection("bob");
    const inbox = inboxSource();
    const source: typeof inbox = {
      ...inbox,
      async check(ctx) {
        if (ctx.connection?.id === bob.id) throw new SignInError("Google revoked access");
        return inbox.check?.(ctx);
      },
    };
    inbox.deliver(ann.id, "hello");
    inbox.deliver(bob.id, "hello");
    const judged: string[] = [];
    const errors: ErrorEvent[] = [];
    await monitor({ source, questions: { urgent }, client: mockJev(() => ({ urgent: 0 })), log: silentLogger })
      .on("judged", (e) => {
        judged.push(e.connection.id);
      })
      .on("error", (e) => {
        errors.push(e);
      })
      .run({ store, connections: [ann, bob] });

    expect(judged).toEqual([ann.id]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ phase: "source", fatal: true, needsSignIn: true, connection: { id: bob.id } });
    expect(errors[0]?.connection).not.toHaveProperty("credentials");
    expect(await store.connections.get(bob.id)).toMatchObject({ status: "needs-sign-in", problem: "Google revoked access" });
    expect(await store.connections.get(ann.id)).toMatchObject({ status: "active" });
  });

  it("keeps a connection active when its check fails for another reason", async () => {
    const store = memoryStore();
    const ann = testConnection("ann");
    const bob = testConnection("bob");
    const inbox = inboxSource();
    const source: typeof inbox = {
      ...inbox,
      async check(ctx) {
        if (ctx.connection?.id === bob.id) throw new Error("503 Service Unavailable");
        return inbox.check?.(ctx);
      },
    };
    inbox.deliver(ann.id, "hello");
    const judged: string[] = [];
    const errors: ErrorEvent[] = [];
    await monitor({ source, questions: { urgent }, client: mockJev(() => ({ urgent: 0 })), log: silentLogger })
      .on("judged", (e) => {
        judged.push(e.connection.id);
      })
      .on("error", (e) => {
        errors.push(e);
      })
      .run({ store, connections: [ann, bob] });

    expect(judged).toEqual([ann.id]);
    expect(errors.map((e) => [e.phase, e.connection?.id, (e.error as Error).message, e.fatal])).toEqual([
      ["source", bob.id, "503 Service Unavailable", undefined],
    ]);
    expect(await store.connections.get(bob.id)).toMatchObject({ status: "active" });
  });

  it("skips connections that are paused or need a new sign-in", async () => {
    const store = memoryStore();
    const source = inboxSource();
    const ann = testConnection("ann");
    const bob = testConnection("bob", { status: "paused" });
    const cy = testConnection("cy", { status: "needs-sign-in", problem: "Google revoked access" });
    for (const connection of [ann, bob, cy]) source.deliver(connection.id, "hello");

    const stats = await monitor({ source, questions: { urgent }, client: mockJev(() => ({ urgent: 0 })), log: silentLogger }).run({
      store,
      connections: [ann, bob, cy],
    });

    expect(source.checks).toEqual([ann.id]);
    expect(stats.judged).toBe(1);
  });

  it("warns when a source that reads accounts has no connections", async () => {
    const warn = vi.fn();
    const stats = await monitor({
      source: inboxSource(),
      questions: { urgent },
      client: mockJev(() => ({ urgent: 0 })),
      log: { ...silentLogger, warn },
    }).run({ store: memoryStore() });

    expect(stats.received).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("No test connections yet. Sign in with `npx jev-events auth test`"));
  });
});

describe("sources", () => {
  it("run() resolves after a finite async source ends", async () => {
    async function* lines() {
      yield "a";
      await flush(1);
      yield "b";
    }
    const judged = vi.fn();
    const stats = await monitor({ source: from(lines()), questions: { hateful }, client: mockJev(() => ({ hateful: 0 })), log: silentLogger })
      .on("judged", judged)
      .run();
    expect(judged).toHaveBeenCalledTimes(2);
    expect(stats.received).toBe(2);
  });

  it("run() rejects when a fixed stream can't connect", async () => {
    const source = manualSource();
    source.start = () => {
      throw new Error("#gone doesn't exist");
    };
    await expect(monitor({ source, questions: { hateful }, client: mockJev(() => ({})), log: silentLogger }).run()).rejects.toThrow(
      "#gone doesn't exist",
    );
  });
});
