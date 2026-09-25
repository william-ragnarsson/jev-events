import type { Question, ResultFor } from "@typesafe-ai/sdk";

import type { ProbabilityPolicy, ScorePolicy, Trigger } from "./types.js";

export type Verdict = { kind: "fire" | "review"; trigger: Trigger } | undefined;

export interface OutcomeSpec {
  event: string;
  question: string;
  label?: string;
  policy: ProbabilityPolicy & ScorePolicy;
}

/** Decide whether one registered outcome fires, goes to review, or does nothing for an answer. */
export function evaluate(spec: OutcomeSpec, question: Question, answer: ResultFor<Question>): Verdict {
  const { policy } = spec;
  const base = { event: spec.event, question: spec.question };

  if (question.type === "choice" && answer.type === "choice" && spec.label !== undefined) {
    const probability = answer.probabilities[spec.label] ?? 0;
    const trigger: Trigger = { ...base, label: spec.label, probability };
    const fires = policy.min === undefined ? answer.choice === spec.label : probability >= policy.min;
    if (fires) return { kind: "fire", trigger };
    if (policy.review !== undefined && probability >= policy.review) return { kind: "review", trigger };
    return undefined;
  }

  if (question.type === "noul" && answer.type === "noul") {
    const probability = answer.noul;
    const trigger: Trigger = { ...base, probability };
    if (probability >= (policy.min ?? 0.5)) return { kind: "fire", trigger };
    if (policy.review !== undefined && probability >= policy.review) return { kind: "review", trigger };
    return undefined;
  }

  if (question.type === "score" && answer.type === "score") {
    const score = answer.score;
    const trigger: Trigger = { ...base, score };
    const atLeast = policy.atLeast ?? (question.criteria.length - 1) / 2;
    if (score >= atLeast) return { kind: "fire", trigger };
    if (policy.review !== undefined && score >= policy.review) return { kind: "review", trigger };
    return undefined;
  }

  return undefined;
}
