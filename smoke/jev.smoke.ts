import { describe, expect, it } from "vitest";

import { choice, from, monitor, noul, silentLogger } from "jev-events";

// Real Jev. Skipped unless TYPESAFE_API_KEY is set, and when TYPESAFE_BASE_URL points at a local
// stand-in. Makes three requests.

const key = process.env.TYPESAFE_API_KEY;
const local = /\/\/(127\.0\.0\.1|localhost)\b/.test(process.env.TYPESAFE_BASE_URL ?? "");
const live = Boolean(key) && key !== "mock" && !local;

const questions = {
  rude: noul("Is this chat message rude or insulting?"),
  kind: choice("What is this chat message?", { question: null, praise: null, insult: null, other: null }),
};

describe.skipIf(!live)("Jev (real API)", () => {
  it("answers yes-or-no and choice questions sensibly", async () => {
    const answers = new Map<string, { rude: number; kind: string }>();
    let model = "";
    const stats = await monitor({
      source: from([
        { id: "insult", text: "you are a worthless idiot, nobody wants you here" },
        { id: "praise", text: "thanks for the stream, that was so much fun!" },
        { id: "question", text: "what game is this?" },
      ]),
      questions,
      log: silentLogger,
    })
      .on("judged", (event) => {
        model = event.model;
        answers.set(event.item.id, { rude: event.answers.rude.noul, kind: event.answers.kind.choice });
      })
      .run();

    expect(stats.errors).toBe(0);
    expect(stats.judged).toBe(3);
    expect(answers.get("insult")?.rude).toBeGreaterThan(0.5);
    expect(answers.get("praise")?.rude).toBeLessThan(0.5);
    expect([...answers].map(([id, answer]) => [id, answer.kind]).sort()).toEqual([
      ["insult", "insult"],
      ["praise", "praise"],
      ["question", "question"],
    ]);
    console.info(`Jev ${model}: ${stats.usage.inputTokens} input tokens, p50 ${stats.latencyMs.p50} ms`);
  });
});
