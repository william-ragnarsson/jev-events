import type { Question, Questions } from "@typesafe-ai/sdk";

import type { ProbabilityPolicy, ScorePolicy, SpecialEventName, Trigger } from "../types.js";

export const SPECIAL = new Set<string>(["judged", "review", "action", "dropped", "error"] satisfies SpecialEventName[]);

export function checkQuestions(questions: Questions): void {
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new TypeError("monitor() needs at least one question.");
  for (const id of ids) {
    if (id.includes(":")) throw new TypeError(`Question id "${id}" can't contain ":".`);
    if (SPECIAL.has(id)) throw new TypeError(`Question id "${id}" is reserved for a built-in event.`);
  }
}

/** Every outcome a monitor can listen for: "kind:question" for choice labels, "hateful" for the rest. */
export function eventNames(questions: Questions): string[] {
  return Object.entries(questions).flatMap(([id, q]) =>
    q.type === "choice" ? Object.keys(q.criteria).map((label) => `${id}:${label}`) : [id],
  );
}

export function checkPolicy(event: string, question: Question, policy: ProbabilityPolicy & ScorePolicy): void {
  const inRange = (key: string, value: number | undefined, max: number) => {
    if (value !== undefined && !(value >= 0 && value <= max)) {
      throw new RangeError(`"${key}" for "${event}" must be between 0 and ${max}, got ${value}.`);
    }
  };
  if (question.type === "score") {
    if (policy.min !== undefined) throw new TypeError(`"${event}" is a score; use { atLeast } instead of { min }.`);
    const top = question.criteria.length - 1;
    inRange("atLeast", policy.atLeast, top);
    inRange("review", policy.review, top);
  } else {
    if (policy.atLeast !== undefined) throw new TypeError(`"${event}" is a probability; use { min } instead of { atLeast }.`);
    inRange("min", policy.min, 1);
    inRange("review", policy.review, 1);
  }
}

/** "hateful p=0.93" or "severity score=2.40", for logs. */
export function summarize(trigger: Trigger): string {
  if (trigger.score !== undefined) return `${trigger.event} score=${trigger.score.toFixed(2)}`;
  if (trigger.probability !== undefined) return `${trigger.event} p=${trigger.probability.toFixed(2)}`;
  return trigger.event;
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === "function";
}
