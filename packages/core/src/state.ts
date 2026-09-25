import type { EntryType, JsonValue, Question, Questions } from "@typesafe-ai/sdk";

import type { Item, Source } from "./types.js";

/** The default lean view of an item: its text, author, roles and facts. */
export function describeItem(item: Item): JsonValue {
  const view: Record<string, JsonValue> = { ...item.facts, text: item.text };
  if (item.author) {
    view.author = item.author.name;
    if (item.author.roles?.length) view.roles = [...item.author.roles];
  }
  return view;
}

export interface StateParts<I extends Item> {
  item: I;
  recent: readonly I[];
  about: JsonValue | undefined;
}

/**
 * Build `{ <noun>: item, recent?: [...], about?: {...} }`. Named keys keep the relationship between
 * the judged item and its context clear to Jev.
 */
export function buildState<I extends Item>(source: Source<I, string>, parts: StateParts<I>): Record<string, JsonValue> {
  const key = source.noun ?? "item";
  const state: Record<string, JsonValue> = {
    [key]: source.describe ? source.describe(parts.item) : describeItem(parts.item),
  };
  if (parts.recent.length > 0) {
    state.recent = parts.recent.map((r) => ({ author: r.author?.name ?? null, text: r.text }));
  }
  if (parts.about !== undefined) state.about = parts.about;
  return state;
}

/**
 * Point every question at one key of the state, so context such as recent messages is read as
 * context rather than judged. Structured instructions that already say what to inspect are kept.
 */
export function inspectQuestions<Q extends Questions>(questions: Q, key: string): Q {
  const targeted: Record<string, Question> = {};
  for (const [id, question] of Object.entries(questions)) {
    targeted[id] = { ...question, instructions: inspect(question.instructions ?? null, key) } as Question;
  }
  return targeted as Q;
}

function inspect(instructions: EntryType, key: string): EntryType {
  if (instructions !== null && typeof instructions === "object" && !Array.isArray(instructions) && "inspect" in instructions) {
    return instructions;
  }
  return { question: instructions, inspect: key };
}
