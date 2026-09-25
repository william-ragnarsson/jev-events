import { styleText } from "node:util";

import type { Question, Questions } from "@typesafe-ai/sdk";

import type { JudgedEvent, ListenerStats } from "../types.js";

type Style = Parameters<typeof styleText>[0];

const LABEL_COLORS: Style[] = ["cyan", "magenta", "yellow", "blue", "green", "red", "white"];
const NAMED_COLORS: Record<string, Style> = {
  question: "cyan",
  hype: "magenta",
  joke: "yellow",
  backseat: "blue",
  spam: "red",
  hateful: ["bold", "red"],
  other: "gray",
};

const paint = (style: Style, text: string) => styleText(style, text, { validateStream: true, stream: process.stdout });

export function percent(p: number): string {
  return `${Math.round(p * 100)}%`;
}

function labelColor(question: Question, label: string): Style {
  const known = NAMED_COLORS[label];
  if (known) return known;
  const labels = question.type === "choice" ? Object.keys(question.criteria) : [];
  return LABEL_COLORS[Math.max(0, labels.indexOf(label)) % LABEL_COLORS.length] as Style;
}

/** The widest badge each question can produce, so columns line up row after row. */
export function badgeWidths(questions: Questions): Record<string, number> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      if (question.type === "choice") return [id, Math.max(...Object.keys(question.criteria).map((label) => label.length)) + 5];
      if (question.type === "noul") return [id, id.length + 7];
      return [id, id.length + 8];
    }),
  );
}

/** One badge per question, e.g. "question 93%", "✔ hateful 91%", "toxicity 2.4/3". */
export function badges(questions: Questions, event: JudgedEvent, min: number): { text: string; width: number; fired: boolean } {
  const parts: string[] = [];
  const widths = badgeWidths(questions);
  let width = 0;
  let fired = false;
  for (const [id, question] of Object.entries(questions)) {
    const answer = event.answers[id];
    if (!answer) continue;
    let plain: string;
    let styled: string;
    if (answer.type === "choice") {
      const p = answer.probabilities[answer.choice] ?? answer.confidence;
      plain = `${answer.choice} ${percent(p)}`;
      styled = paint(labelColor(question, answer.choice), plain);
      if (answer.choice !== "other") fired = true;
    } else if (answer.type === "noul") {
      const yes = answer.noul >= min;
      plain = `${yes ? "✔" : "·"} ${id} ${percent(answer.noul)}`;
      styled = yes ? paint(id === "hateful" ? ["bold", "red"] : "green", plain) : paint("gray", plain);
      if (yes) fired = true;
    } else {
      const top = question.type === "score" ? question.criteria.length - 1 : 0;
      plain = `${id} ${answer.score.toFixed(1)}/${top}`;
      const high = answer.score >= top / 2;
      styled = paint(high ? "yellow" : "gray", plain);
      if (high) fired = true;
    }
    const pad = Math.max(0, (widths[id] ?? plain.length) - plain.length);
    parts.push(styled + " ".repeat(pad));
    width += plain.length + pad + 2;
  }
  return { text: parts.join("  "), width, fired };
}

function fit(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (width <= 1) return "";
  return flat.length <= width ? flat.padEnd(width) : `${flat.slice(0, width - 1)}…`;
}

export function formatRow(questions: Questions, event: JudgedEvent, min: number, hideText = false): { line: string; fired: boolean } {
  const columns = Math.max(60, process.stdout.columns ?? 100);
  const time = event.item.at.toTimeString().slice(0, 8);
  const author = fit(event.item.author?.name ?? "", 14);
  const tag = badges(questions, event, min);
  const latency = event.cached ? "cached" : `${event.latencyMs}ms`;
  const textWidth = columns - 8 - 2 - 14 - 2 - tag.width - latency.length - 3;
  const text = hideText ? paint("gray", fit("[hidden]", Math.max(10, textWidth))) : fit(event.item.text, Math.max(10, textWidth));
  return {
    line: `${paint("gray", time)}  ${paint("bold", author)}  ${text}  ${tag.text}  ${paint("gray", latency)}`,
    fired: tag.fired,
  };
}

export function formatSummary(stats: ListenerStats): string {
  const dropped = Object.entries(stats.dropped)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${reason}`)
    .join(", ");
  const parts = [
    `judged ${stats.judged}`,
    ...(stats.cached ? [`${stats.cached} from cache`] : []),
    ...(dropped ? [`skipped ${dropped}`] : []),
    ...(stats.latencyMs.p50 === null ? [] : [`p50 ${stats.latencyMs.p50}ms`, `p95 ${stats.latencyMs.p95}ms`]),
    `${stats.usage.inputTokens.toLocaleString("en-US")} tokens`,
    `≈ $${stats.estimatedCostUsd.toFixed(4)}`,
  ];
  return paint("gray", parts.join(" · "));
}

export { paint };
