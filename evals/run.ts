/**
 * Score the chat recipes against a labeled dataset.
 *
 *   npm run eval                          one request per message, the library's default
 *   npm run eval -- --mode all            also plain state and batched requests
 *   npm run eval -- --mode batched --batch 8
 *   npm run eval -- --mock                offline plumbing check; results are never published
 *
 * Needs TYPESAFE_API_KEY unless --mock. Results land in evals/results/<dataset>.<mode>.json;
 * `npm run eval:report` turns them into the benchmarks page.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  describeItem,
  from,
  JEV_USD_PER_MILLION_INPUT_TOKENS,
  monitor,
  recipes,
  silentLogger,
  toItem,
  TypeSafeClient,
  type Item,
  type JevClient,
  type JudgedEvent,
  type Question,
  type Questions,
} from "jev-events";
import { mockJev } from "jev-events/testing";

import { loadDataset, toChatItem, type ChatExample, type Flag } from "./lib/dataset.js";
import { buildReport, type EvalReport, type Prediction } from "./lib/metrics.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MODES = ["single", "plain", "batched"] as const;
type Mode = (typeof MODES)[number];

/** The recipes a Twitch moderator would start from. */
const QUESTIONS = {
  kind: recipes.chat.kind,
  hateful: recipes.chat.hateful,
  question: recipes.chat.question,
  streamIssue: recipes.chat.streamIssue,
  spam: recipes.chat.spam,
} satisfies Questions;
const FLAG_IDS: Flag[] = ["hateful", "question", "streamIssue", "spam"];

interface Run {
  predictions: Map<string, Prediction>;
  errors: number;
  requests: number;
  model: string;
}

const { values: args } = parseArgs({
  options: {
    dataset: { type: "string", default: "chat" },
    mode: { type: "string", default: "single" },
    batch: { type: "string", default: "8" },
    rate: { type: "string", default: "8" },
    limit: { type: "string" },
    model: { type: "string" },
    mock: { type: "boolean", default: false },
    out: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (args.help) {
  process.stdout.write(
    [
      "Usage: npm run eval -- [options]",
      "  --dataset <name>   evals/datasets/<name>.jsonl (default chat)",
      "  --mode <mode>      single | plain | batched | all (default single)",
      "  --batch <n>        messages per request in batched mode (default 8)",
      "  --rate <n>         requests per second (default 8)",
      "  --limit <n>        only the first n examples",
      "  --model <id>       e.g. jev-1.13.0 (default: the API's default)",
      "  --mock             offline plumbing check with a keyword mock; never published",
      "  --out <dir>        where results go (default evals/results)",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const modes: Mode[] = args.mode === "all" ? [...MODES] : [args.mode as Mode];
if (!modes.every((mode) => MODES.includes(mode))) fail(`--mode must be one of ${MODES.join(", ")} or all`);
if (!args.mock && !process.env.TYPESAFE_API_KEY) {
  fail("Set TYPESAFE_API_KEY (https://docs.typesafe.ai/introduction/quickstart), or pass --mock for an offline plumbing check.");
}

const datasetPath = join(ROOT, "evals", "datasets", `${args.dataset}.jsonl`);
const all = loadDataset(datasetPath);
const examples = args.limit ? all.slice(0, Number(args.limit)) : all;
const client: JevClient = args.mock ? keywordMock() : new TypeSafeClient();
const outDir = args.out ?? join(ROOT, "evals", "results", ...(args.mock ? ["mock"] : []));

// ---------------------------------------------------------------------------

/** Through `monitor()`, exactly as an app would: one request per message. */
async function runMonitor(examples: ChatExample[], mode: "single" | "plain", rate: number): Promise<Run> {
  const run: Run = { predictions: new Map(), errors: 0, requests: 0, model: "unknown" };
  const source = from(
    examples.map((example, index) => toChatItem(example, index)),
    { id: `eval:${args.dataset}`, noun: "message" },
  );
  const judge = monitor({
    source,
    questions: QUESTIONS,
    client,
    log: silentLogger,
    rate: { perSecond: rate, burst: rate, concurrency: Math.max(1, Math.ceil(rate)) },
    ...(args.model ? { model: args.model } : {}),
    // "single" is what sources send by default: a named message, questions pointed at it.
    // "plain" sends the bare text with the recipes unchanged, to check that the structure helps.
    ...(mode === "plain" ? { state: (item) => item.text, inspect: false as const } : { inspect: "message" }),
  });
  judge.on("judged", (event) => {
    run.model = event.model;
    if (!event.cached) run.requests++;
    run.predictions.set(event.item.id, fromJudged(event));
    progress(run.predictions.size, examples.length, mode);
  });
  judge.on("error", (event) => {
    run.errors++;
    process.stderr.write(`\n${event.phase} error: ${event.error instanceof Error ? event.error.message : String(event.error)}\n`);
  });
  await judge.run();
  return run;
}

function fromJudged(event: JudgedEvent<Item, typeof QUESTIONS>): Prediction {
  const { answers } = event;
  return {
    id: event.item.id,
    kind: { choice: answers.kind.choice, confidence: answers.kind.confidence },
    flags: Object.fromEntries(FLAG_IDS.map((flag) => [flag, answers[flag].noul])),
    latencyMs: event.latencyMs,
    inputTokens: event.usage.inputTokens,
  };
}

/** Several messages per request, each question pointed at `messages[i]`. */
async function runBatched(examples: ChatExample[], size: number, rate: number): Promise<Run> {
  const run: Run = { predictions: new Map(), errors: 0, requests: 0, model: "unknown" };
  const batches: ChatExample[][] = [];
  for (let i = 0; i < examples.length; i += size) batches.push(examples.slice(i, i + size));
  const offsets = new Map(batches.map((batch, index) => [batch, index * size]));

  await pool(batches, Math.max(1, Math.ceil(rate / 2)), async (batch) => {
    const offset = offsets.get(batch) ?? 0;
    const messages = batch.map((example, i) => describeItem(toItem(toChatItem(example, offset + i))));
    const questions: Record<string, Question> = {};
    batch.forEach((_, i) => {
      for (const [id, question] of Object.entries(QUESTIONS)) {
        questions[`${id}_${i}`] = { ...question, instructions: { question: question.instructions ?? null, inspect: `messages[${i}]` } } as Question;
      }
    });
    const started = performance.now();
    try {
      const result = await client.systemOne({ state: { messages }, questions, ...(args.model ? { model: args.model } : {}) });
      const latencyMs = performance.now() - started;
      run.requests++;
      run.model = result.model;
      const answers = result.answers as Record<string, { choice?: string; confidence?: number; noul?: number }>;
      batch.forEach((example, i) => {
        const kind = answers[`kind_${i}`];
        run.predictions.set(example.id, {
          id: example.id,
          kind: kind?.choice === undefined ? undefined : { choice: kind.choice, confidence: kind.confidence ?? 0 },
          flags: Object.fromEntries(FLAG_IDS.map((flag) => [flag, answers[`${flag}_${i}`]?.noul ?? Number.NaN])),
          latencyMs,
          inputTokens: result.usage.input_tokens / batch.length,
        });
      });
      progress(run.predictions.size, examples.length, "batched");
    } catch (error) {
      run.errors++;
      process.stderr.write(`\nbatch error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  });
  return run;
}

async function pool<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) await work(items[next++] as T);
    }),
  );
}

// ---------------------------------------------------------------------------

const pct = (value: number | null | undefined) => (value === null || value === undefined ? "–" : `${Math.round(value * 100)}%`);
const ms = (value: number | null) => (value === null ? "–" : `${Math.round(value)} ms`);

function summarize(report: EvalReport): string {
  const kind = report.kind.clear;
  const lines = [
    `◆ ${report.dataset} · ${report.mode} · ${report.model}${report.mock ? " · MOCK (not a real result)" : ""}`,
    `  ${report.answered}/${report.items} answered in ${report.requests} requests, ${report.errors} errors`,
    `  latency     p50 ${ms(report.latencyMs.p50)} · p95 ${ms(report.latencyMs.p95)}`,
    `  cost        ${report.tokens.inputPerItem?.toFixed(0) ?? "–"} input tokens per message · $${report.tokens.usdPer1kItems?.toFixed(4) ?? "–"} per 1,000 messages`,
    `  kind        ${pct(kind.accuracy)} exact · ${pct(kind.lenientAccuracy)} accepting alternatives (clear cases, n=${kind.n})`,
  ];
  for (const flag of FLAG_IDS) {
    const { clear } = report.flags[flag] ?? {};
    if (!clear) continue;
    const at = (t: number) => clear.thresholds.find((score) => score.threshold === t);
    const cell = (t: number) => `p≥${t}: P ${pct(at(t)?.precision)} R ${pct(at(t)?.recall)}`;
    lines.push(`  ${flag.padEnd(11)} ${cell(0.5)} · ${cell(0.8)} · best F1 ${clear.best?.f1?.toFixed(2) ?? "–"} at ${clear.best?.threshold ?? "–"}`);
  }
  const slice = (name: string) => {
    const s = report.slices[name];
    return s ? `${name} (n=${s.n}) kind ${pct(s.kindAccuracy)} · hateful ${pct(s.hatefulAgreement)}` : undefined;
  };
  for (const name of ["non-english", "slang", "sarcasm", "evasion", "identity-mention", "hard-negative"]) {
    const line = slice(name);
    if (line) lines.push(`  slice       ${line}`);
  }
  return lines.join("\n");
}

function progress(done: number, total: number, label: string): void {
  if (process.stderr.isTTY) process.stderr.write(`\r\u001b[2K  ${label}: ${done}/${total}`);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** Keyword rules standing in for Jev, so the pipeline can be checked offline. Its numbers mean nothing. */
function keywordMock(): JevClient {
  const kinds: Array<[string, RegExp]> = [
    ["spam", /dot com|\.com|\.xyz|buy |follow/],
    ["question", /\?/],
    ["backseat", /\b(go|use|check|turn|take|equip) /],
    ["hype", /let'?s ?go|pog|clutch|insane|gg/],
    ["joke", /kekw|lul|lol|lmao|💀/],
  ];
  const flags: Record<string, RegExp> = {
    hateful: /kill yourself|kys|go back|disgusting|terrorist|worthless|die/,
    question: /\?/,
    streamIssue: /sound|audio|mic|buffer|lag|frozen|black screen|pixelated/,
    spam: /dot com|\.com|\.xyz|buy |followers/,
  };
  return mockJev(
    ({ state, questions }) => {
      const answers: Record<string, number | string> = {};
      for (const [id, question] of Object.entries(questions)) {
        // Batched requests point each question at messages[i]; read only that message.
        const target = (question.instructions as { inspect?: string } | null)?.inspect;
        const index = target ? /\[(\d+)\]/.exec(target)?.[1] : undefined;
        const subject = index === undefined ? state : (state as { messages: unknown[] }).messages[Number(index)];
        const text = JSON.stringify(subject).toLowerCase();
        const base = id.replace(/_\d+$/, "");
        answers[id] =
          base === "kind" ? (kinds.find(([, pattern]) => pattern.test(text))?.[0] ?? "other") : flags[base]?.test(text) ? 0.9 : 0.1;
      }
      return answers;
    },
    { latencyMs: 5, model: "keyword-mock" },
  );
}

async function main(): Promise<void> {
  for (const mode of modes) {
    const started = Date.now();
    const run =
      mode === "batched"
        ? await runBatched(examples, Number(args.batch), Number(args.rate))
        : await runMonitor(examples, mode, Number(args.rate));
    const report = buildReport({
      dataset: args.dataset,
      mode: mode === "batched" ? `batched-${args.batch}` : mode,
      model: run.model,
      mock: args.mock,
      examples,
      predictions: run.predictions,
      errors: run.errors,
      requests: run.requests,
      usdPerMillionInputTokens: JEV_USD_PER_MILLION_INPUT_TOKENS,
    });
    const file = join(outDir, `${report.dataset}.${report.mode}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    if (process.stderr.isTTY) process.stderr.write("\r\u001b[2K");
    process.stdout.write(`${summarize(report)}\n  ${((Date.now() - started) / 1000).toFixed(1)}s · wrote ${relative(process.cwd(), file)}\n\n`);
  }
}

await main();
