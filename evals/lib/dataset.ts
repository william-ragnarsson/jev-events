import { readFileSync } from "node:fs";

import type { ItemInput } from "jev-events";

/** Labels the chat recipes are scored against. */
export const KINDS = ["question", "hype", "joke", "backseat", "spam", "other"] as const;
export const FLAGS = ["hateful", "question", "streamIssue", "spam"] as const;

export type Kind = (typeof KINDS)[number];
export type Flag = (typeof FLAGS)[number];

export interface ChatExample {
  id: string;
  text: string;
  /** ISO 639-1 language code. */
  lang: string;
  /** The one right answer to `recipes.chat.kind`. Absent when no kind fits (e.g. hateful messages). */
  kind?: Kind;
  /** Other kinds a careful human would also accept. */
  kindAlso?: Kind[];
  /** Noul recipes whose answer is yes. Every other flag is no. */
  flags?: Flag[];
  /** Slices: slang, sarcasm, banter, evasion, emote, identity-mention, in-game-violence, hard-negative. */
  tags?: string[];
  /** Reasonable people could label this differently. Reported separately from the clear cases. */
  borderline?: boolean;
  firstMessage?: boolean;
  reply?: { author: string; text: string };
}

export function loadDataset(path: string): ChatExample[] {
  const examples: ChatExample[] = [];
  const ids = new Set<string>();
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (!line.trim()) return;
      const where = `${path}:${index + 1}`;
      let example: ChatExample;
      try {
        example = JSON.parse(line) as ChatExample;
      } catch (error) {
        throw new Error(`${where}: invalid JSON (${(error as Error).message})`);
      }
      if (!example.id || typeof example.text !== "string" || !example.lang) throw new Error(`${where}: needs id, text and lang`);
      if (ids.has(example.id)) throw new Error(`${where}: duplicate id "${example.id}"`);
      ids.add(example.id);
      for (const kind of [example.kind, ...(example.kindAlso ?? [])]) {
        if (kind !== undefined && !KINDS.includes(kind)) throw new Error(`${where}: unknown kind "${kind}"`);
      }
      for (const flag of example.flags ?? []) {
        if (!FLAGS.includes(flag)) throw new Error(`${where}: unknown flag "${flag}"`);
      }
      if (example.kind === undefined && !example.flags?.length) throw new Error(`${where}: has no labels`);
      examples.push(example);
    });
  return examples;
}

export const hasFlag = (example: ChatExample, flag: Flag) => example.flags?.includes(flag) ?? false;

/** What a monitor sees: a Twitch-shaped chat message with neutral author names. */
export function toChatItem(example: ChatExample, index: number): ItemInput {
  const facts = {
    ...(example.firstMessage ? { firstMessage: true } : {}),
    ...(example.reply ? { replyingTo: example.reply } : {}),
  };
  return {
    id: example.id,
    text: example.text,
    author: { id: `u${index}`, name: `viewer_${100 + index}` },
    ...(Object.keys(facts).length > 0 ? { facts } : {}),
  };
}
