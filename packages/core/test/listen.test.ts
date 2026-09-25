import { afterEach, describe, expect, it, vi } from "vitest";

import {
  choice,
  DailyBudget,
  defineAction,
  from,
  listen,
  noul,
  score,
  silentLogger,
  type ActionEvent,
  type DroppedEvent,
  type ErrorEvent,
  type Item,
  type JudgedEvent,
  type ReviewEvent,
} from "../src/index.js";
import { mockJev } from "../src/testing.js";
import { flush, manualSource } from "./helpers.js";

const kind = choice("What is this chat message?", { question: null, hateful: null, other: null });
const hateful = noul("Is this message hateful?");
const severity = score("How severe is it?", ["none", "mild", "bad", "severe"]);

const textOf = (state: unknown) => JSON.stringify(state);

afterEach(() => {
  vi.useRealTimers();
});

describe("listen", () => {
  it("judges every item and emits judged events with typed answers", async () => {
    const jev = mockJev(({ state }) => ({ kind: textOf(state).includes("?") ? "question" : "other" }));
    const judged: Array<[string, string]> = [];
    const stats = await listen(from(["when is the next stream?", "gg"]), { kind }, { client: jev, log: silentLogger })
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
    await listen(from(["x"]), { kind }, { client: jev, log: silentLogger })
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
    await listen(from(["p0.95", "p0.6", "p0.3"]), { hateful }, { client: jev, log: silentLogger })
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
    await listen(from(["s0.4", "s1.5", "s2.9"]), { severity }, { client: jev, log: silentLogger })
      .on("severity", midpoint)
      .on("severity", { atLeast: 2.5 }, severe)
      .run();

    expect(midpoint.mock.calls.map((call) => call[0].item.text)).toEqual(["s1.5", "s2.9"]);
    expect(severe.mock.calls.map((call) => call[0].trigger.score)).toEqual([2.9]);
  });

  it("rejects unknown events and mismatched policies with helpful errors", () => {
    const chat = listen(manualSource(), { kind, hateful, severity }, { client: mockJev(() => ({})) });
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
    expect(() => listen(manualSource(), { judged: hateful })).toThrow(/reserved/);
    expect(() => listen(manualSource(), { "a:b": hateful })).toThrow(/can't contain/);
    expect(() => listen(manualSource(), {})).toThrow(/at least one question/);
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
    await listen(from([{ text: "you idiot", author: "viewer1" }]), { hateful }, {
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
    const chat = listen(source, { hateful }, { client: mockJev(() => ({ hateful: 0.99 })), dryRun: false, log: silentLogger })
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

  it("refuses to arm actions on a source that can't act", async () => {
    const chat = listen(manualSource({ canAct: false }), { hateful }, { client: mockJev(() => ({})), dryRun: false }).on(
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
    await listen(from(["x"]), { hateful }, { client: mockJev(() => ({ hateful: 1 })), dryRun: false, log: silentLogger })
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
});

describe("pipeline", () => {
  it("drops filtered items before they cost anything", async () => {
    const jev = mockJev(() => ({ hateful: 0 }));
    const dropped: DroppedEvent[] = [];
    await listen(from(["!command", "hello"]), { hateful }, { client: jev, filter: (item) => !item.text.startsWith("!"), log: silentLogger })
      .on("dropped", (e) => {
        dropped.push(e);
      })
      .run();

    expect(jev.calls).toHaveLength(1);
    expect(dropped.map((e) => [e.item.text, e.reason])).toEqual([["!command", "filtered"]]);
  });

  it("limits requests per second and drops the oldest items when the queue overflows", async () => {
    vi.useFakeTimers();
    const jev = mockJev(() => ({ hateful: 0 }));
    const source = manualSource();
    const dropped: string[] = [];
    const chat = listen(source, { hateful }, {
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
    const chat = listen(source, { hateful }, {
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

    expect(jev.calls.map((call) => textOf(call.state))).toEqual([
      expect.stringContaining('"a"'),
      expect.stringContaining('"b"'),
    ]);
    expect(dropped).toEqual(["c:stale", "d:stale"]);
    await chat.stop();
  });

  it("reuses answers for identical text when caching is on", async () => {
    const jev = mockJev(() => ({ hateful: 0.9 }), { latencyMs: 5 });
    const judged: JudgedEvent[] = [];
    await listen(from(["BUY FOLLOWERS", "buy   followers", "hi"]), { hateful }, { client: jev, cache: true, log: silentLogger })
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
    const stats = await listen(from(["a", "b", "c"]), { hateful }, {
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

  it("shares one DailyBudget between listeners", async () => {
    const budget = new DailyBudget(1_000);
    const jev = mockJev(() => ({ hateful: 0 }), { inputTokens: 600 });
    const options = { client: jev, budget, rate: { concurrency: 1 }, log: silentLogger };
    const first = await listen(from(["a"]), { hateful }, options).run();
    expect(first.judged).toBe(1);
    expect(budget).toMatchObject({ spent: 600, remaining: 400, exhausted: false });

    const second = await listen(from(["b", "c"]), { hateful }, options).run();
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
    const stats = await listen(from(["a", "b"]), { hateful }, { client: jev, rate: { concurrency: 1 }, log: silentLogger })
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
    const chat = listen(source, { hateful }, {
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
    await listen(from([{ text: "hello", author: "ann" }], { noun: "message" }), { hateful }, { client: jev, log: silentLogger }).run();

    expect(jev.calls[0]?.state).toEqual({ message: { text: "hello", author: "ann" } });
    expect(jev.calls[0]?.questions.hateful?.instructions).toBe("Is this message hateful?");
  });

  it("adds recent items and facts as context, and points questions at the item", async () => {
    const jev = mockJev(() => ({ hateful: 0 }));
    const source = manualSource({ defaults: { recent: 2 } });
    const chat = listen(source, { hateful }, {
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
    await listen(from<Item | string>(["hi"]), { hateful }, {
      client: jev,
      state: (item) => ({ chat_line: item.text }),
      log: silentLogger,
    }).run();

    expect(jev.calls[0]?.state).toEqual({ chat_line: "hi" });
    expect(jev.calls[0]?.questions.hateful?.instructions).toBe("Is this message hateful?");
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
    const stats = await listen(from(lines()), { hateful }, { client: mockJev(() => ({ hateful: 0 })), log: silentLogger })
      .on("judged", judged)
      .run();
    expect(judged).toHaveBeenCalledTimes(2);
    expect(stats.received).toBe(2);
  });
});
