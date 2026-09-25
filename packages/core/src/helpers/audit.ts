import { createWriteStream } from "node:fs";

import type { Questions } from "@typesafe-ai/sdk";

import type { Listener } from "../listen.js";
import type { AnySource, Item } from "../types.js";

export interface LogToOptions {
  /** Write item text into the log. Default true. Turn off to keep only ids and answers. */
  includeText?: boolean;
}

/**
 * Append every judgment, review, action, drop and error to a JSONL file: an audit trail of
 * what Jev decided, with probabilities, and what was done about it.
 */
export function logTo(path: string, options: LogToOptions = {}) {
  const includeText = options.includeText ?? true;
  return <S extends AnySource, Q extends Questions>(listener: Listener<S, Q>) => {
    const stream = createWriteStream(path, { flags: "a" });
    const write = (type: string, data: Record<string, unknown>) => {
      stream.write(`${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`);
    };
    const view = (item: Item) => ({
      id: item.id,
      ...(item.author ? { author: item.author.name } : {}),
      ...(includeText ? { text: item.text } : {}),
    });

    listener.on("judged", (e) =>
      write("judged", { item: view(e.item), answers: e.answers, latencyMs: e.latencyMs, usage: e.usage, cached: e.cached }),
    );
    listener.on("review", (e) => write("review", { item: view(e.item), trigger: e.trigger, handler: e.handler }));
    listener.on("action", (e) =>
      write("action", { item: view(e.event.item), action: e.action, description: e.description, status: e.status, reason: e.reason, trigger: e.event.trigger }),
    );
    listener.on("dropped", (e) => write("dropped", { item: view(e.item), reason: e.reason }));
    listener.on("error", (e) =>
      write("error", { phase: e.phase, message: e.error instanceof Error ? e.error.message : String(e.error), ...(e.item ? { item: view(e.item) } : {}) }),
    );

    return () => new Promise<void>((resolve) => stream.end(resolve));
  };
}
