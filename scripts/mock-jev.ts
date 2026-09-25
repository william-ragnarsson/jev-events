/**
 * A stand-in for TypeSafe's API, for working on the website and relay without a key:
 *
 *   npm run mock-jev
 *   TYPESAFE_API_KEY=mock TYPESAFE_BASE_URL=http://127.0.0.1:8799 npm start -w @jev-events/live-relay
 *
 * Answers are random or keyword-based and mean nothing. Never record a replay or publish
 * numbers while it runs.
 */
import { createServer } from "node:http";

interface Question {
  type: "noul" | "choice" | "score";
  criteria?: Record<string, unknown> | unknown[];
}

const port = Number(process.argv[2] ?? 8799);

function answer(question: Question, text: string): unknown {
  if (question.type === "noul") {
    return { type: "noul", noul: /idiot|trash|stupid|hate/.test(text) ? 0.91 : Math.random() * 0.2 };
  }
  if (question.type === "choice") {
    const labels = Object.keys(question.criteria ?? {});
    const pick = text.includes("?") && labels.includes("question") ? "question" : labels[Math.floor(Math.random() * labels.length)]!;
    const probabilities = Object.fromEntries(
      labels.map((label) => [label, label === pick ? 0.7 + Math.random() * 0.29 : 0.3 / Math.max(1, labels.length - 1)]),
    );
    return { type: "choice", choice: pick, confidence: probabilities[pick], probabilities };
  }
  const levels = Array.isArray(question.criteria) ? question.criteria.length : 4;
  return { type: "score", score: Math.random() * (levels - 1), confidence: 0.8, legend: {}, probabilities: {} };
}

createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk.toString()));
  request.on("end", () => {
    const { questions = {}, state } = JSON.parse(body || "{}") as { questions?: Record<string, Question>; state?: unknown };
    const text = JSON.stringify(state ?? "").toLowerCase();
    const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, answer(question, text)]));
    setTimeout(
      () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ model: "jev-mock", answers, usage: { input_tokens: 180 + Math.floor(text.length / 4), output_tokens: 0 } }));
      },
      120 + Math.random() * 150,
    );
  });
}).listen(port, "127.0.0.1", () => process.stderr.write(`mock jev on http://127.0.0.1:${port} (answers mean nothing)\n`));
