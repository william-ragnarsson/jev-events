import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

interface FakeQuestion {
  type: "noul" | "choice" | "score";
  instructions?: unknown;
  criteria?: Record<string, unknown> | unknown[];
}

export interface FakeJevRequest {
  path: string;
  authorization: string | undefined;
  body: { state?: unknown; questions?: Record<string, FakeQuestion>; model?: string };
}

export interface FakeJev {
  /** Pass this as TYPESAFE_BASE_URL. */
  readonly url: string;
  /** Every request received, in order. */
  readonly requests: FakeJevRequest[];
  close(): Promise<void>;
}

/**
 * A local stand-in for TypeSafe's HTTP API, for tests that run the real SDK client, such as the CLI
 * in a child process. Answers are keyword-based so tests can predict them: text containing "idiot"
 * is rude, and text with a "?" is a question. The key "rejected-key" gets a 401, like a revoked key.
 */
export async function fakeJevServer(): Promise<FakeJev> {
  const requests: FakeJevRequest[] = [];
  const server = createServer((request, response) => {
    void readBody(request).then((raw) => {
      const body = JSON.parse(raw || "{}") as FakeJevRequest["body"];
      requests.push({ path: request.url ?? "", authorization: request.headers.authorization, body });
      if (request.headers.authorization === "Bearer rejected-key") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ detail: "Invalid API key" }));
        return;
      }
      const text = JSON.stringify(body.state ?? "").toLowerCase();
      const answers = Object.fromEntries(Object.entries(body.questions ?? {}).map(([id, question]) => [id, answer(question, text)]));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: "jev-fake", answers, usage: { input_tokens: 120, output_tokens: 0 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function answer(question: FakeQuestion, text: string): unknown {
  if (question.type === "noul") return { type: "noul", noul: text.includes("idiot") ? 0.93 : 0.04 };
  if (question.type === "choice") {
    const labels = Object.keys(question.criteria ?? {});
    const pick = text.includes("?") && labels.includes("question") ? "question" : (labels.at(-1) ?? "");
    const probabilities = Object.fromEntries(labels.map((label) => [label, label === pick ? 0.9 : 0.1 / Math.max(1, labels.length - 1)]));
    return { type: "choice", choice: pick, confidence: 0.9, probabilities };
  }
  const levels = Array.isArray(question.criteria) ? question.criteria : [];
  return {
    type: "score",
    score: 0,
    confidence: 1,
    legend: Object.fromEntries(levels.map((level, index) => [String(index), level])),
    probabilities: Object.fromEntries(levels.map((_, index) => [String(index), index === 0 ? 1 : 0])),
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}
