import type {
  ChoiceResponse,
  NoulResponse,
  Question,
  Questions,
  RequestOptions,
  ScoreResponse,
  SystemOneRequest,
  SystemOneResult,
} from "@typesafe-ai/sdk";

import type { JevClient } from "./types.js";

/**
 * A shorthand answer: a probability for a noul, a label or `{ label: probability }` for a
 * choice, a number for a score, or a full SDK response.
 */
export type MockAnswer = number | string | Record<string, number> | NoulResponse | ChoiceResponse | ScoreResponse;

export interface MockJevOptions {
  latencyMs?: number;
  model?: string;
  inputTokens?: number;
}

export interface MockJev extends JevClient {
  /** Every request received, in order. */
  readonly calls: SystemOneRequest<Questions>[];
}

/**
 * A fake Jev client for tests. `respond` returns an answer per question id.
 *
 * @example
 * ```ts
 * const jev = mockJev(({ state }) => ({ hateful: JSON.stringify(state).includes("idiot") ? 0.97 : 0.02 }));
 * listen(from(["hi", "you idiot"]), { hateful: noul("Is this hateful?") }, { client: jev });
 * ```
 */
export function mockJev(
  respond: (request: SystemOneRequest<Questions>) => Record<string, MockAnswer> | Promise<Record<string, MockAnswer>>,
  options: MockJevOptions = {},
): MockJev {
  const calls: SystemOneRequest<Questions>[] = [];
  return {
    calls,
    async systemOne<const Q extends Questions>(request: SystemOneRequest<Q>, requestOptions?: RequestOptions) {
      calls.push(request);
      if (options.latencyMs) await sleep(options.latencyMs, requestOptions?.signal);
      const raw = await respond(request);
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(request.questions)) {
        const answer = raw[id];
        if (answer === undefined) throw new Error(`mockJev: no answer for question "${id}".`);
        answers[id] = toResponse(id, question, answer);
      }
      return {
        model: options.model ?? "jev-mock",
        answers,
        usage: { input_tokens: options.inputTokens ?? 100, output_tokens: 0 },
      } as SystemOneResult<Q>;
    },
  };
}

function toResponse(id: string, question: Question, answer: MockAnswer): NoulResponse | ChoiceResponse | ScoreResponse {
  if (typeof answer === "object" && "type" in answer) return answer as NoulResponse | ChoiceResponse | ScoreResponse;
  switch (question.type) {
    case "noul":
      return { type: "noul", noul: Number(answer) };
    case "choice": {
      const labels = Object.keys(question.criteria);
      if (typeof answer === "string" && !labels.includes(answer)) {
        throw new Error(`mockJev: "${answer}" is not a label of "${id}" (${labels.join(", ")}).`);
      }
      const probabilities = Object.fromEntries(
        labels.map((label) => [label, typeof answer === "string" ? (label === answer ? 1 : 0) : ((answer as Record<string, number>)[label] ?? 0)]),
      );
      const choice = labels.reduce((best, label) => ((probabilities[label] ?? 0) > (probabilities[best] ?? 0) ? label : best));
      return { type: "choice", choice, confidence: probabilities[choice] ?? 0, probabilities };
    }
    case "score": {
      const value = Number(answer);
      const levels = question.criteria.map((_, index) => String(index));
      return {
        type: "score",
        score: value,
        confidence: 1,
        legend: Object.fromEntries(question.criteria.map((description, index) => [String(index), description])),
        probabilities: Object.fromEntries(levels.map((level) => [level, Number(level) === Math.round(value) ? 1 : 0])),
      } as ScoreResponse;
    }
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}
