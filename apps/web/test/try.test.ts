import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { JEV_USD_PER_MILLION_INPUT_TOKENS as CORE_PRICE, buildState, noul, recipes } from "jev-events";
import { KNOWN_BOTS as CORE_BOTS, ignoredChat as coreIgnored, itemFromIrc, parseIrcLine as coreParse, twitchChat } from "jev-events/public";
import type { Question, Questions } from "@typesafe-ai/sdk";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { inspectQuestions } from "../../../packages/core/src/state.js";
import type { RecipeEntry } from "../lib/builder/generate.js";
import { channelLogin, chatMessage, ignoredChat, KNOWN_BOTS, parseIrcLine } from "../lib/try/chat.js";
import {
  chatRecipes,
  EXAMPLE_QUESTION,
  JEV_USD_PER_MILLION_INPUT_TOKENS,
  jevRequest,
  LIMITS,
  parseTryRequest,
  RECENT,
  TRY_QUESTIONS,
  tryCode,
  type TryQuestion,
  type TryResult,
} from "../lib/try/jev.js";
import { tryMessage, TryRun, type RunView } from "../lib/try/run.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RECIPES = JSON.parse(readFileSync(join(ROOT, "apps/web/generated/recipes.json"), "utf8")) as RecipeEntry[];
const OPTIONS = chatRecipes(RECIPES);

/** A chat line as Twitch sends it. */
function privmsg(login: string, text: string, tags: Record<string, string> = {}): string {
  const all = { "display-name": login, id: `id-${login}-${text.length}`, "tmi-sent-ts": "1700000000000", ...tags };
  const encoded = Object.entries(all)
    .map(([key, value]) => `${key}=${value.replace(/\\/g, "\\\\").replace(/;/g, "\\:").replace(/ /g, "\\s")}`)
    .join(";");
  return `@${encoded} :${login}!${login}@${login}.tmi.twitch.tv PRIVMSG #somechannel :${text}`;
}

const LINES = [
  privmsg("viewer1", "is the stream lagging for anyone?"),
  privmsg("modguy", "calm down chat", { "display-name": "ModGuy", badges: "moderator/1,partner/1", mod: "1" }),
  privmsg("newbie", "hi, first time here", { "first-msg": "1", badges: "founder/0" }),
  privmsg("replier", "@Alice yes it is", {
    "reply-parent-display-name": "Alice",
    "reply-parent-user-login": "alice",
    "reply-parent-msg-body": "is this live? ; really",
  }),
  privmsg("vipper", "\u0001ACTION waves at chat\u0001", { badges: "vip/1,subscriber/12" }),
  privmsg("nodisplay", "no display name", { "display-name": "" }),
  privmsg("staffer", "hello from Twitch", { badges: "staff/1,broadcaster/1" }),
  privmsg("nightbot", "Follow the channel!"),
  privmsg("viewer2", "!discord"),
  "@badge-info=;badges=;color=;display-name=Tagless;emotes=;id=only-some;mod=0 :tagless!tagless@tagless.tmi.twitch.tv PRIVMSG #somechannel :a :colon inside",
];

describe("channelLogin", () => {
  it.each([
    ["xqc", "xqc"],
    ["  XQC ", "xqc"],
    ["#xqc", "xqc"],
    ["@xqc", "xqc"],
    ["twitch.tv/xqc", "xqc"],
    ["www.twitch.tv/xqc", "xqc"],
    ["https://www.twitch.tv/xqc?sr=a", "xqc"],
    ["https://m.twitch.tv/xqc/", "xqc"],
    ["https://www.twitch.tv/popout/xqc/chat?popout=", "xqc"],
    ["https://www.twitch.tv/moderator/xqc", "xqc"],
    ["kai_cenat", "kai_cenat"],
  ])("finds the channel in %j", (input, login) => {
    expect(channelLogin(input)).toBe(login);
  });

  it.each(["", "  ", "x qc", "xqc!", "a".repeat(26), "https://twitch.tv/", "https://twitch.tv/directory", "https://example.com/xqc", "https://twitch.tv.evil.com/xqc", "https://twitch.tv:99999/xqc"])(
    "finds no channel in %j",
    (input) => {
      expect(channelLogin(input)).toBeUndefined();
    },
  );

  it("agrees with twitchChat() on which names are channels", () => {
    for (const input of ["xqc", "#xqc", "kai_cenat", "a".repeat(25)]) expect(() => twitchChat(channelLogin(input)!)).not.toThrow();
  });
});

describe("reading chat, next to twitchChat()", () => {
  it("parses lines as the library does", () => {
    const others = [
      "PING :tmi.twitch.tv",
      "@emote-only=0;room-id=1;slow=0 :tmi.twitch.tv ROOMSTATE #somechannel",
      "@msg-id=msg_channel_suspended :tmi.twitch.tv NOTICE #gone :This channel does not exist or has been suspended.",
      ":tmi.twitch.tv RECONNECT",
      "",
      "   ",
    ];
    for (const line of [...LINES, ...others]) expect(parseIrcLine(line)).toEqual(coreParse(line));
  });

  it("sees the same message, author, roles and reply", () => {
    for (const line of LINES) {
      const mine = chatMessage(parseIrcLine(line)!)!;
      const item = itemFromIrc(coreParse(line)!)!;
      expect(mine).toEqual({
        id: item.id,
        author: item.author.name,
        login: item.author.login,
        text: item.text,
        roles: item.author.roles,
        firstMessage: item.firstMessage,
        ...(item.reply ? { replyingTo: item.reply } : {}),
      });
    }
  });

  it("skips the same commands and bots", () => {
    expect(KNOWN_BOTS).toEqual(CORE_BOTS);
    const skipped = LINES.filter((line) => ignoredChat(chatMessage(parseIrcLine(line)!)!));
    expect(skipped).toEqual(LINES.filter((line) => coreIgnored(itemFromIrc(coreParse(line)!)!)));
    expect(skipped).toHaveLength(2);
  });

  it("reads anything but a chat message as nothing", () => {
    expect(chatMessage(parseIrcLine("PING :tmi.twitch.tv")!)).toBeUndefined();
  });

  it("keeps the colour a chatter picked for their name", () => {
    expect(chatMessage(parseIrcLine(privmsg("colorful", "hi", { color: "#1E90FF" }))!)?.color).toBe("#1E90FF");
    expect(chatMessage(parseIrcLine(privmsg("plain", "hi", { color: "" }))!)?.color).toBeUndefined();
  });
});

describe("what the route asks Jev", () => {
  const questions: [TryQuestion, Questions][] = [
    ...OPTIONS.map((option): [TryQuestion, Questions] => [{ recipe: option.id }, { [option.id]: (recipes.chat as Record<string, unknown>)[option.id] as Question }]),
    [{ custom: "  Is this about the game?  " }, { custom: noul("Is this about the game?") }],
  ];

  it("offers the chat recipes that need nothing more", () => {
    expect(OPTIONS.map((option) => option.id)).toEqual(["kind", "hateful", "question", "streamIssue", "spam"]);
    expect(OPTIONS[0]?.labels).toEqual(Object.keys(recipes.chat.kind.criteria));
  });

  it("puts the ones that answer yes or no on the page", () => {
    for (const { id } of TRY_QUESTIONS) expect(OPTIONS.find((option) => option.id === id)?.type).toBe("noul");
  });

  it("is what a monitor on twitchChat() sends, with the three messages before as context", () => {
    const source = twitchChat("somechannel");
    expect(source.defaults?.recent).toBe(RECENT);
    const readable = LINES.filter((line) => !coreIgnored(itemFromIrc(coreParse(line)!)!));

    for (const [question, expected] of questions) {
      readable.forEach((line, i) => {
        const before = readable.slice(Math.max(0, i - RECENT), i);
        const item = itemFromIrc(coreParse(line)!)!;
        const state = buildState(source, { item, recent: before.map((l) => itemFromIrc(coreParse(l)!)!), about: undefined });

        // The round trip: the page's message, as JSON, read back by the route.
        const recent = before.map((l) => chatMessage(parseIrcLine(l)!)!).map(({ author, text }) => ({ author, text }));
        const body = JSON.parse(JSON.stringify({ question, message: tryMessage(chatMessage(parseIrcLine(line)!)!), recent }));
        const request = parseTryRequest(body);
        if (typeof request === "string") throw new Error(request);
        expect(jevRequest(request, RECIPES)).toEqual({ state, questions: inspectQuestions(expected, "message") });
      });
    }
  });

  it("knows no other recipes", () => {
    expect(jevRequest({ question: { recipe: "spoiler" }, message: { author: "a", text: "b" }, recent: [] }, RECIPES)).toBeUndefined();
    expect(jevRequest({ question: { recipe: "toxicity" }, message: { author: "a", text: "b" }, recent: [] }, RECIPES)).toBeUndefined();
  });

  it("prices tokens as the library does", () => {
    expect(JEV_USD_PER_MILLION_INPUT_TOKENS).toBe(CORE_PRICE);
  });
});

describe("parseTryRequest", () => {
  const message = { author: "someone", text: "hello" };

  it("keeps what it knows and drops the rest", () => {
    expect(parseTryRequest({ question: { recipe: "kind" }, message: { ...message, roles: [], firstMessage: false, extra: 1 }, recent: [], more: 2 })).toEqual({
      question: { recipe: "kind" },
      message,
      recent: [],
    });
    expect(parseTryRequest({ question: { custom: " Is it? " }, message })).toEqual({ question: { custom: "Is it?" }, message, recent: [] });
  });

  it.each([
    ["no body", null],
    ["no question", { message }],
    ["an empty question", { question: { custom: "   " }, message }],
    ["a long question", { question: { custom: "a".repeat(301) }, message }],
    ["a recipe id that isn't one", { question: { recipe: "../etc" }, message }],
    ["no text", { question: { recipe: "kind" }, message: { author: "someone", text: "" } }],
    ["long text", { question: { recipe: "kind" }, message: { author: "someone", text: "a".repeat(501) } }],
    ["a long name", { question: { recipe: "kind" }, message: { author: "a".repeat(65), text: "hi" } }],
    ["a made-up role", { question: { recipe: "kind" }, message: { ...message, roles: ["admin"] } }],
    ["a broken reply", { question: { recipe: "kind" }, message: { ...message, replyingTo: { author: "x" } } }],
    ["four earlier messages", { question: { recipe: "kind" }, message, recent: Array.from({ length: 4 }, () => message) }],
    ["a broken earlier message", { question: { recipe: "kind" }, message, recent: [{ text: "hi" }] }],
  ])("turns down %s", (_, body) => {
    expect(typeof parseTryRequest(body)).toBe("string");
  });
});

/** A stand-in for Twitch chat's WebSocket. */
class FakeSocket {
  static all: FakeSocket[] = [];
  sent: string[] = [];
  closed = false;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(line: string) {
    this.sent.push(line);
  }
  close() {
    this.closed = true;
  }
  /** Twitch sends these lines. */
  receive(...lines: string[]) {
    this.onmessage?.({ data: lines.map((line) => `${line}\r\n`).join("") });
  }
  join() {
    this.onopen?.();
    this.receive("@emote-only=0;room-id=1 :tmi.twitch.tv ROOMSTATE #somechannel");
  }
}

describe("TryRun", () => {
  let fetch: Mock<(url: string, init: RequestInit) => Promise<Response>>;
  let respond: (body: unknown) => Response;
  let run: TryRun | undefined;

  const answer = (p = 0.9): TryResult => ({ answer: { type: "noul", p }, model: "jev-test", inputTokens: 200, latencyMs: 120 });
  const socket = () => FakeSocket.all.at(-1)!;
  const start = (question: TryQuestion = { recipe: "hateful" }) => {
    const views: RunView[] = [];
    run = new TryRun({ channel: "somechannel", key: "test-key", question, onChange: (view) => views.push(view) });
    run.start();
    return { run, views };
  };
  const chat = (n: number, from = 0) => Array.from({ length: n }, (_, i) => privmsg(`viewer${from + i}`, `message ${from + i}`));
  const sentBodies = () => fetch.mock.calls.map(([, init]) => JSON.parse(init.body as string));

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    respond = (body) => Response.json(body);
    fetch = vi.fn(async (_url: string, _init: RequestInit) => respond(answer()));
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("fetch", fetch);
  });

  afterEach(() => {
    run?.stop();
    run = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("joins the channel anonymously, as twitchChat() does", async () => {
    const { run } = start();
    expect(socket().url).toBe("wss://irc-ws.chat.twitch.tv:443");
    socket().onopen?.();
    expect(socket().sent.slice(0, 3)).toEqual(["CAP REQ :twitch.tv/tags twitch.tv/commands", "PASS SCHMOOPIIE", expect.stringMatching(/^NICK justinfan\d{5}$/)]);
    expect(socket().sent[3]).toBe("JOIN #somechannel");
    expect(run.view.phase).toBe("joining");
    socket().receive("PING :tmi.twitch.tv");
    expect(socket().sent.at(-1)).toBe("PONG :tmi.twitch.tv");
    socket().receive("@room-id=1 :tmi.twitch.tv ROOMSTATE #somechannel");
    expect(run.view.phase).toBe("reading");
    expect(run.view.endsAt).toBe(Date.now() + 5 * 60_000);
  });

  it("asks about each message with the key, the question and the messages before it", async () => {
    const { run, views } = start();
    socket().join();
    socket().receive(...chat(3));
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetch).toHaveBeenCalledTimes(3);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/try");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-key");
    expect(sentBodies().map((body) => body.recent.length)).toEqual([0, 1, 2]);
    expect(sentBodies()[2]).toEqual({
      question: { recipe: "hateful" },
      message: { author: "viewer2", text: "message 2" },
      recent: [
        { author: "viewer0", text: "message 0" },
        { author: "viewer1", text: "message 1" },
      ],
    });
    expect(run.view).toMatchObject({ read: 3, answered: 3, skipped: 0, latencyMs: 120, model: "jev-test" });
    expect(run.view.spentUsd).toBeCloseTo((3 * 200 * CORE_PRICE) / 1_000_000);
    expect(run.view.rows.map((row) => row.message.text)).toEqual(["message 0", "message 1", "message 2"]);
    expect(run.view.rows.at(-1)?.state).toEqual({ status: "answered", answer: { type: "noul", p: 0.9 }, latencyMs: 120 });
    // The page hears about it, but not once per change.
    expect(views.at(-1)).toBe(run.view);
    expect(views.length).toBeLessThan(10);
  });

  it("keeps the newest 60 for the page, oldest first as in a chat", async () => {
    const { run } = start();
    socket().join();
    for (let i = 0; i < 61; i++) {
      socket().receive(...chat(1, i));
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(run.view.answered).toBe(61);
    expect(run.view.rows).toHaveLength(60);
    expect(run.view.rows[0]?.message.text).toBe("message 1");
    expect(run.view.rows.at(-1)?.message.text).toBe("message 60");
  });

  it("leaves out commands and bots", async () => {
    const { run } = start();
    socket().join();
    socket().receive(privmsg("viewer", "!discord"), privmsg("nightbot", "Follow!"), privmsg("viewer", "a real one"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(run.view.read).toBe(1);
  });

  it(`asks about ${LIMITS.perSecond} messages a second at most and skips the rest, as its code says`, async () => {
    const { run } = start();
    socket().join();
    // Ten at once: the burst goes out, the newest three wait, and the rest are skipped.
    socket().receive(...chat(10));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(LIMITS.burst);
    expect(run.view).toMatchObject({ read: 10, skipped: 10 - LIMITS.burst - LIMITS.maxQueue });

    await vi.advanceTimersByTimeAsync(1600);
    expect(fetch).toHaveBeenCalledTimes(LIMITS.burst + LIMITS.maxQueue);
    expect(sentBodies().map((body) => body.message.text)).toEqual(["message 0", "message 1", "message 7", "message 8", "message 9"]);
    expect(run.view.answered).toBe(5);
  });

  it("waits when TypeSafe asks it to slow down, and skips what went stale", async () => {
    respond = () => Response.json({ error: "TypeSafe asked to slow down.", retryAfterMs: 5000 }, { status: 429 });
    const { run } = start();
    socket().join();
    socket().receive(...chat(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(run.view.phase).toBe("waiting");
    expect(run.view.note).toMatch(/waits 5 s/);
    expect(run.view.rows[0]?.state).toEqual({ status: "failed", error: "TypeSafe asked to slow down." });

    respond = (body) => Response.json(body);
    socket().receive(...chat(1, 1));
    await vi.advanceTimersByTimeAsync(4000);
    socket().receive(...chat(1, 2));
    await vi.advanceTimersByTimeAsync(1500);
    expect(run.view.phase).toBe("reading");
    // "message 1" waited over three seconds, so only "message 2" was asked about.
    expect(sentBodies().map((body) => body.message.text)).toEqual(["message 0", "message 2"]);
    expect(run.view.skipped).toBe(1);
  });

  it("stops when TypeSafe turns down the key", async () => {
    respond = () => Response.json({ error: "TypeSafe didn't accept that key." }, { status: 401 });
    const { run } = start();
    socket().join();
    socket().receive(...chat(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(run.view).toMatchObject({ phase: "stopped", failed: true, note: "TypeSafe didn't accept that key." });
    expect(socket().closed).toBe(true);
  });

  it("stops after three errors in a row", async () => {
    fetch.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    const { run } = start();
    socket().join();
    socket().receive(...chat(3));
    await vi.advanceTimersByTimeAsync(2000);
    expect(run.view).toMatchObject({ phase: "stopped", failed: true });
    expect(run.view.note).toMatch(/3 errors in a row/);
  });

  it("cancels the questions still waiting for an answer when stopped", async () => {
    let signal: AbortSignal | undefined;
    fetch.mockImplementation((_url, init) => {
      signal = init.signal ?? undefined;
      return new Promise(() => {});
    });
    const { run, views } = start();
    socket().join();
    socket().receive(...chat(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(run.view.rows[0]?.state.status).toBe("asking");

    run.stop("Stopped.");
    expect(signal?.aborted).toBe(true);
    expect(socket().closed).toBe(true);
    expect(run.view).toMatchObject({ phase: "stopped", note: "Stopped.", failed: false });
    expect(run.view.rows[0]?.state.status).toBe("stopped");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(views.at(-1)?.phase).toBe("stopped");
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("stops by itself after five minutes", async () => {
    const { run } = start();
    socket().join();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(run.view).toMatchObject({ phase: "stopped", failed: false });
  });

  it("says when nobody is writing", async () => {
    const { run } = start();
    socket().join();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run.view.quiet).toBe(true);
    socket().receive(...chat(1));
    expect(run.view.quiet).toBe(false);
  });

  it("gives up on a channel that doesn't exist", () => {
    const { run } = start();
    socket().onopen?.();
    socket().receive("@msg-id=msg_channel_suspended :tmi.twitch.tv NOTICE #somechannel :This channel does not exist or has been suspended.");
    expect(run.view).toMatchObject({ phase: "stopped", failed: true, note: "#somechannel is suspended or doesn't exist." });
  });

  it("gives up when it can't join", async () => {
    const { run } = start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.view).toMatchObject({ phase: "stopped", failed: true });
  });

  it("reconnects when Twitch closes the connection", async () => {
    const { run } = start();
    socket().join();
    socket().onclose?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(2);
    socket().join();
    expect(run.view.phase).toBe("reading");
    socket().receive(...chat(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

/** Type-check the files with the compiler, as the project they're pasted into would. */
function typecheck(dir: string, rootNames: string[]): string {
  const converted = ts.convertCompilerOptionsFromJson(
    {
      target: "es2023",
      lib: ["es2023"],
      module: "nodenext",
      moduleResolution: "nodenext",
      verbatimModuleSyntax: true,
      strict: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      isolatedModules: true,
      noEmit: true,
      customConditions: ["source"],
      types: ["node"],
      typeRoots: [join(ROOT, "node_modules/@types")],
      paths: {
        "jev-events": [join(ROOT, "packages/core/src/index.ts")],
        "jev-events/public": [join(ROOT, "packages/core/src/public/index.ts")],
      },
    },
    dir,
  );
  if (converted.errors.length > 0) throw new Error(ts.flattenDiagnosticMessageText(converted.errors[0]!.messageText, "\n"));
  const program = ts.createProgram({ rootNames, options: converted.options });
  const mine = program.getSourceFiles().filter((source) => source.fileName.startsWith(dir));
  const diagnostics = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...mine.flatMap((source) => [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]),
  ];
  return ts.formatDiagnostics(diagnostics, { getCanonicalFileName: (name) => name, getCurrentDirectory: () => dir, getNewLine: () => "\n" });
}

describe("the code next to the chat", () => {
  let dir: string;
  const files: string[] = [];

  const write = (path: string, code: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, code);
    return path;
  };

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "jev-try-")));
    write(join(dir, "package.json"), '{ "type": "module" }\n');
    const questions: TryQuestion[] = [
      ...OPTIONS.map((option) => ({ recipe: option.id })),
      { custom: 'An "odd" question, with `backticks` and ${braces}?' },
      { custom: "" },
    ];
    questions.forEach((question, i) => files.push(write(join(dir, `monitor-${i}.ts`), tryCode(i % 2 ? "xqc" : undefined, question, RECIPES))));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("type-checks for every question the page offers", () => {
    expect(files).toHaveLength(OPTIONS.length + 2);
    expect(typecheck(dir, files)).toBe("");
  }, 120_000);

  it("uses the channel, the question and the page's limits", () => {
    const code = tryCode("xqc", { recipe: "kind" }, RECIPES);
    expect(code).toContain('source: twitchChat("xqc")');
    expect(code).toContain("questions: { kind: recipes.chat.kind }");
    expect(code).toContain("e.answers.kind.choice");
    expect(code).toContain(`rate: { perSecond: ${LIMITS.perSecond}, burst: ${LIMITS.burst} }`);
    expect(code).toContain(`maxQueue: ${LIMITS.maxQueue}`);
    expect(code).toContain(`maxLagMs: ${LIMITS.maxLagMs}`);
    expect(tryCode(undefined, { custom: "" }, RECIPES)).toContain(`custom: noul(${JSON.stringify(EXAMPLE_QUESTION)})`);
  });
});
