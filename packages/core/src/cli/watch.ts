import { createInterface } from "node:readline";

import { choice, noul, type Question, type Questions } from "@typesafe-ai/sdk";

import { listen } from "../listen.js";
import { createLogger } from "../logger.js";
import { bluesky } from "../public/bluesky.js";
import { twitchChat } from "../public/twitch.js";
import { recipes } from "../recipes.js";
import { from } from "../sources/from.js";
import { webhook } from "../sources/webhook.js";
import type { AnySource, JudgedEvent } from "../types.js";
import { formatRow, formatSummary, paint } from "./format.js";

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

const POST_TOPICS = choice("What is this post mainly about?", {
  tech: "Software, AI, science or gadgets",
  politics: "Politics, government or current affairs",
  sports: "Sports and games",
  entertainment: "Movies, TV, music, celebrities or memes",
  art: "Art, photography or creative work",
  personal: "The author's own life, feelings or day",
  other: "Anything else",
});

export function resolveSource(spec: string, flags: WatchFlags): AnySource {
  const [kind, ...restParts] = spec.split(":");
  const rest = restParts.join(":");
  switch (kind) {
    case "twitch":
      if (!rest) throw new UsageError("Name a channel: twitch:<channel>");
      return twitchChat(rest);
    case "bluesky":
      return bluesky({
        ...(rest ? { keywords: rest.split(",") } : {}),
        ...(flags.lang ? { langs: flags.lang.split(",") } : {}),
      });
    case "stdin": {
      const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
      return from(lines, { id: "stdin", noun: "line", map: (line: string) => (line.trim() ? line : null) });
    }
    case "webhook":
      return webhook({ port: rest ? Number(rest) : 8787 });
    default:
      throw new UsageError(`Unknown source "${spec}". Try twitch:<channel>, bluesky, stdin or webhook.`);
  }
}

export function resolveQuestions(sourceSpec: string, flags: WatchFlags): Questions {
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

  if (sourceSpec.startsWith("twitch")) return { kind: recipes.chat.kind, hateful: recipes.chat.hateful };
  if (sourceSpec.startsWith("bluesky")) return { topic: POST_TOPICS };
  throw new UsageError('Tell Jev what to look for, e.g. --ask "Is this an error a human should look at?"');
}

export async function watch(sourceSpec: string | undefined, flags: WatchFlags): Promise<void> {
  if (!sourceSpec) throw new UsageError("Name a source, e.g. jev-events watch twitch:<channel>");
  const questions = resolveQuestions(sourceSpec, flags);
  const source = resolveSource(sourceSpec, flags);
  const min = flags.min === undefined ? 0.5 : Number(flags.min);
  const filter = flags.filter ? new RegExp(flags.filter, "i") : undefined;

  const listener = listen(source, questions, {
    log: createLogger("warn"),
    rate: { perSecond: flags.rate ? Number(flags.rate) : 8, burst: 8 },
    maxQueue: 20,
    ...(flags.context === undefined ? {} : { context: { recent: Number(flags.context) } }),
    ...(filter ? { filter: (item) => filter.test(item.text) } : {}),
    ...(flags.model ? { model: flags.model } : {}),
  });

  const hide = (event: JudgedEvent) => {
    const hateful = event.answers.hateful;
    return hateful?.type === "noul" && hateful.noul >= 0.8;
  };
  listener.on("judged", (event) => {
    if (flags.json) {
      process.stdout.write(
        `${JSON.stringify({ at: event.item.at, author: event.item.author?.name, text: event.item.text, answers: event.answers, latencyMs: event.latencyMs })}\n`,
      );
      return;
    }
    const row = formatRow(questions, event, min, hide(event));
    if (!flags.only || row.fired) process.stdout.write(`${row.line}\n`);
  });
  listener.on("error", (event) => {
    const message = event.error instanceof Error ? event.error.message : String(event.error);
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
    await listener.stop();
    if (!flags.json) process.stdout.write(`\n${formatSummary(listener.stats())}\n`);
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());

  if (sourceSpec === "stdin") {
    const stats = await listener.run();
    if (!flags.json) process.stdout.write(`\n${formatSummary(stats)}\n`);
    return;
  }
  await listener.start();
  if (!flags.json && source.id.startsWith("twitch")) {
    process.stdout.write(paint("gray", "  connected. Waiting for chat…\n\n"));
  }
}
