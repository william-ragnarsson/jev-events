import { createInterface } from "node:readline";

import {
  AuthenticationError,
  choice,
  noul,
  PermissionDeniedError,
  TypeSafeClient,
  type Question,
  type Questions,
} from "@typesafe-ai/sdk";

import type { Connection } from "../connection.js";
import { createLogger } from "../logger.js";
import { coreOf, monitor } from "../monitor/index.js";
import { bluesky } from "../public/bluesky.js";
import { twitchChat } from "../public/twitch.js";
import { recipes } from "../recipes.js";
import { from } from "../sources/from.js";
import { webhook } from "../sources/webhook.js";
import { fileStore } from "../store/file.js";
import { memoryStore } from "../store/memory.js";
import type { Store } from "../store/types.js";
import type { AnySource, JudgedEvent } from "../types.js";
import { envOrigin, isIgnored, KEY_URL, readSecret, saveToEnv } from "./env.js";
import { formatRow, formatSummary, forThisShell, paint } from "./format.js";

export interface WatchFlags {
  ask?: string[];
  choice?: string;
  options?: string;
  recipe?: string[];
  filter?: string;
  min?: string;
  rate?: string;
  context?: string;
  only?: boolean;
  json?: boolean;
  model?: string;
  lang?: string;
}

export class UsageError extends Error {}

/**
 * What an integration package exports as `cli.<source>` so `jev-events watch <source>` can use it.
 * The CLI loads the package only when you watch one of its sources.
 */
export interface WatchHook {
  /** Build the source; `target` is whatever follows the colon, e.g. the channel in `slack:general`. */
  source(target: string): AnySource | Promise<AnySource>;
  /** Asked when you don't pass questions yourself. */
  questions: Questions;
  /**
   * Printed once the source is connected, e.g. "Showing your 5 latest emails, then new ones as they
   * arrive." A function gets the source and what its `session()` returned for each connection.
   */
  connected?: string | ((source: AnySource, sessions: unknown[]) => string);
  /** What `jev-events auth` connects, for "Connect your Google account first". */
  account?: string;
  /**
   * A connection built from environment variables, such as SLACK_BOT_TOKEN, to watch instead of the
   * ones `jev-events auth` saved. Undefined when they aren't set.
   */
  fromEnv?(): Connection | undefined;
}

/** Sources that live in an integration package, and the package that has them. */
const INTEGRATIONS: Record<string, string> = {
  gmail: "@jev-events/google",
  calendar: "@jev-events/google",
  slack: "@jev-events/slack",
};
const BUILT_IN = ["twitch", "bluesky", "stdin", "webhook"];

const POST_TOPICS = choice("What is this post mainly about?", {
  tech: "Software, AI, science or gadgets",
  politics: "Politics, government or current affairs",
  sports: "Sports and games",
  entertainment: "Movies, TV, music, celebrities or memes",
  art: "Art, photography or creative work",
  personal: "The author's own life, feelings or day",
  other: "Anything else",
});

export function parseSourceSpec(spec: string): { kind: string; target: string } {
  const [kind = "", ...rest] = spec.split(":");
  if (!BUILT_IN.includes(kind) && !INTEGRATIONS[kind]) {
    throw new UsageError(`Unknown source "${spec}". Try gmail, calendar, slack, twitch:<channel>, bluesky, stdin or webhook.`);
  }
  return { kind, target: rest.join(":") };
}

/** Load an integration's `cli.<kind>` hook, with a clear message when the package isn't installed. */
export async function loadHook(kind: string): Promise<WatchHook | undefined> {
  const name = INTEGRATIONS[kind];
  if (!name) return undefined;
  let mod: { cli?: Record<string, WatchHook> };
  try {
    mod = (await import(name)) as typeof mod;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND" && String(error).includes(name);
    if (!missing) throw error;
    throw new UsageError(`Install ${name} first: npm i ${name}`);
  }
  const hook = mod.cli?.[kind];
  if (!hook) throw new UsageError(`${name} doesn't support "jev-events watch ${kind}" yet.`);
  return hook;
}

async function resolveSource(kind: string, target: string, flags: WatchFlags, hook: WatchHook | undefined): Promise<AnySource> {
  if (hook) return hook.source(target);
  switch (kind) {
    case "twitch":
      if (!target) throw new UsageError("Name a channel: twitch:<channel>");
      return twitchChat(target);
    case "bluesky":
      return bluesky({
        ...(target ? { keywords: target.split(",") } : {}),
        ...(flags.lang ? { langs: flags.lang.split(",") } : {}),
      });
    case "stdin": {
      const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
      return from(lines, { id: "stdin", noun: "line", map: (line: string) => (line.trim() ? line : null) });
    }
    default:
      return webhook({ port: target ? Number(target) : 8787 });
  }
}

export function resolveQuestions(kind: string, flags: WatchFlags, defaults?: Questions): Questions {
  const questions: Record<string, Question> = {};
  (flags.ask ?? []).forEach((ask, index) => {
    const match = /^([A-Za-z][\w-]{0,23})=(.+)$/s.exec(ask);
    const id = match?.[1] ?? `q${index + 1}`;
    questions[id] = noul(match?.[2] ?? ask);
  });
  if (flags.choice) {
    const labels = (flags.options ?? "").split(",").map((label) => label.trim()).filter(Boolean);
    if (labels.length < 2) throw new UsageError('--choice needs --options with at least two labels, e.g. -o "question,hype,other"');
    questions.choice = choice(flags.choice, Object.fromEntries(labels.map((label) => [label, null])));
  }
  for (const name of flags.recipe ?? []) {
    const [group, key] = name.split(".");
    const recipe = (recipes as Record<string, Record<string, unknown>>)[group ?? ""]?.[key ?? ""];
    if (!recipe || typeof recipe !== "object") {
      const known = Object.entries(recipes).flatMap(([g, entries]) =>
        Object.entries(entries).filter(([, v]) => typeof v === "object").map(([k]) => `${g}.${k}`),
      );
      throw new UsageError(`Unknown recipe "${name}". Available: ${known.join(", ")}`);
    }
    questions[key as string] = recipe as Question;
  }
  if (Object.keys(questions).length > 0) return questions;

  if (defaults) return defaults;
  if (kind === "twitch") return { kind: recipes.chat.kind, hateful: recipes.chat.hateful };
  if (kind === "bluesky") return { topic: POST_TOPICS };
  throw new UsageError('Tell Jev what to look for, e.g. --ask "Is this an error a human should look at?"');
}

/**
 * Make sure there's a TypeSafe API key. .env was already loaded; when it has none and you're at a
 * terminal, ask for the key once and save it to .env.
 */
async function ensureApiKey(canPrompt: boolean): Promise<void> {
  if (process.env.TYPESAFE_API_KEY) return;
  if (!canPrompt) {
    throw new UsageError(
      `No TypeSafe API key found. Put this line in a file called .env in this folder:\n\n    TYPESAFE_API_KEY=<your key>\n\n  No key yet? Get one at ${KEY_URL}`,
    );
  }
  process.stdout.write(`${paint(["bold", "magenta"], "◆ jev-events")} needs your TypeSafe API key. No key yet? Get one at ${KEY_URL}\n`);
  const key = await readSecret("  Paste it here: ");
  if (!key) throw new UsageError("No key entered.");
  process.env.TYPESAFE_API_KEY = key;
  const path = saveToEnv("TYPESAFE_API_KEY", key);
  envOrigin.TYPESAFE_API_KEY = path;
  process.stdout.write(paint("gray", `  Saved to ${path}. You won't be asked again.\n`));
  if (!isIgnored(path)) process.stdout.write(paint("yellow", "  Add .env to your .gitignore so the key stays out of git.\n"));
  process.stdout.write("\n");
}

/**
 * Sources of an integration read the accounts `jev-events auth` saved in .jev-events. Say how to add
 * one when there's none that works, before asking for an API key.
 */
async function ensureConnected(integration: string, hook: WatchHook | undefined): Promise<void> {
  const connections = await fileStore().connections.list({ integration });
  if (connections.some((connection) => (connection.status ?? "active") === "active")) return;
  const signIn = `npx jev-events auth ${integration}`;
  const stuck = connections.at(-1);
  if (!stuck) throw new Error(`Connect ${hook?.account ?? `a ${integration} account`} first: ${signIn}`);
  const problem = stuck.problem ? `\n  ${stuck.problem[0]?.toUpperCase()}${stuck.problem.slice(1)}${/[.!?)]$/.test(stuck.problem) ? "" : "."}` : "";
  throw new Error(`${stuck.label ?? stuck.id} needs a new sign-in: ${signIn}${problem}`);
}

/**
 * Where a watch keeps its state: in memory, so every watch starts fresh instead of catching up on
 * everything since the last one. Connections, and tokens renewed while watching, are saved in
 * .jev-events.
 */
function watchStore(): Store {
  const state = memoryStore();
  const saved = fileStore();
  return {
    get: (key) => state.get(key),
    set: (key, value, options) => state.set(key, value, options),
    delete: (key) => state.delete(key),
    claim: (key, options) => state.claim(key, options),
    add: (key, amount, options) => state.add(key, amount, options),
    connections: saved.connections,
    flush: async () => saved.flush?.(),
  };
}

export async function watch(sourceSpec: string | undefined, flags: WatchFlags): Promise<void> {
  if (!sourceSpec) throw new UsageError("Name a source, e.g. jev-events watch gmail");
  const { kind, target } = parseSourceSpec(sourceSpec);
  const hook = await loadHook(kind);
  const questions = resolveQuestions(kind, flags, hook?.questions);
  const min = flags.min === undefined ? 0.5 : Number(flags.min);
  const filter = flags.filter ? new RegExp(flags.filter, "i") : undefined;
  // Before the key prompt, so "connect your account first" comes before being asked for a key.
  const source = await resolveSource(kind, target, flags, hook);
  const envConnection = source.integration ? hook?.fromEnv?.() : undefined;
  if (source.integration && !envConnection) await ensureConnected(source.integration, hook);
  await ensureApiKey(kind !== "stdin" && Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const client = new TypeSafeClient();

  const watching = monitor({
    source,
    questions,
    client,
    log: createLogger("warn"),
    rate: { perSecond: flags.rate ? Number(flags.rate) : 8, burst: 8 },
    maxQueue: 20,
    ...(flags.context === undefined ? {} : { context: { recent: Number(flags.context) } }),
    ...(filter ? { filter: (item: { text: string }) => filter.test(item.text) } : {}),
    ...(flags.model ? { model: flags.model } : {}),
  });

  const hide = (event: JudgedEvent) => {
    const hateful = event.answers.hateful;
    return hateful?.type === "noul" && hateful.noul >= 0.8;
  };
  watching.on("judged", (event) => {
    if (flags.json) {
      process.stdout.write(
        `${JSON.stringify({ at: event.item.at, author: event.item.author?.name, text: event.item.text, answers: event.answers, latencyMs: event.latencyMs })}\n`,
      );
      return;
    }
    const row = formatRow(questions, event, min, hide(event));
    if (!flags.only || row.fired) process.stdout.write(`${row.line}\n`);
  });
  watching.on("error", (event) => {
    if (event.error instanceof AuthenticationError || event.error instanceof PermissionDeniedError) {
      // Every item would fail the same way, so stop with one clear message instead.
      const where = envOrigin.TYPESAFE_API_KEY ?? "your shell";
      process.stderr.write(
        `${paint("red", "✖")} TypeSafe didn't accept the API key (TYPESAFE_API_KEY from ${where}). Check it, or get a new one at ${KEY_URL}\n`,
      );
      process.exit(2);
    }
    const reason = event.error instanceof Error ? event.error.message : String(event.error);
    const signIn = !event.needsSignIn || !source.integration
      ? ""
      : envConnection
        ? ` Check ${envConnection.label ?? "the environment variables"}.`
        : ` Sign in again: npx jev-events auth ${source.integration}`;
    const message = forThisShell(`${reason}${signIn}`);
    if (event.fatal) {
      // The source stopped, such as when the account was signed out; say why, and once no account
      // is left, stop too. Stopping first saves that the account needs a new sign-in.
      process.stderr.write(`${paint("red", "✖")} ${message}\n`);
      setImmediate(() => {
        if (watching.stats().running === 0) void watching.stop().finally(() => process.exit(1));
      });
      return;
    }
    process.stderr.write(`${paint("red", `${event.phase} error:`)} ${message}\n`);
  });

  if (!flags.json) {
    const asking = Object.entries(questions)
      .map(([id, q]) => `${id}${q.type === "choice" ? ` (${Object.keys(q.criteria).join("/")})` : ""}`)
      .join(", ");
    process.stdout.write(`${paint(["bold", "magenta"], "◆ jev-events")}  watching ${paint("bold", source.id)}  ·  asking ${asking}\n`);
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === "noul" && typeof q.instructions === "string") process.stdout.write(paint("gray", `  ${id}: ${q.instructions}\n`));
    }
    process.stdout.write(paint("gray", "  connecting… (ctrl-c to stop)\n\n"));
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(130);
    stopping = true;
    await watching.stop();
    if (!flags.json) process.stdout.write(`\n${formatSummary(watching.stats())}\n`);
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());

  if (kind === "stdin") {
    const stats = await watching.run();
    if (!flags.json) process.stdout.write(`\n${formatSummary(stats)}\n`);
    return;
  }
  // Environment connections stay in memory; saved ones are read from, and renewed in, .jev-events.
  await watching.start(envConnection ? { connections: [envConnection] } : source.integration ? { store: watchStore() } : {});
  if (flags.json) return;
  if (hook) {
    const sessions = [...coreOf(watching).runs].map((run) => run.session);
    const connected = typeof hook.connected === "function" ? hook.connected(source, sessions) : hook.connected;
    process.stdout.write(paint("gray", `  connected. ${connected ?? `Waiting for new ${source.noun ?? "item"}s…`}\n\n`));
  }
  else if (kind === "twitch") process.stdout.write(paint("gray", "  connected. Waiting for chat…\n\n"));
}
