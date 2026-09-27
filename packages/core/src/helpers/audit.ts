import { createWriteStream } from "node:fs";

import type { Questions } from "@typesafe-ai/sdk";

import type { ConnectionInfo } from "../connection.js";
import type { Monitor } from "../monitor/index.js";
import type { AnySource, Item } from "../types.js";

export interface LogToOptions {
  /** Write item text into the log. Default true. Turn off to keep only ids and answers. */
  includeText?: boolean;
}

/**
 * Append every judgment, review, action, drop and error to a JSONL file: an audit trail of
 * what Jev decided, with probabilities, and what was done about it. Each line names the monitor
 * and the connection it was about.
 */
export function logTo(path: string, options: LogToOptions = {}) {
  const includeText = options.includeText ?? true;
  return <S extends AnySource, Q extends Questions>(monitor: Monitor<S, Q>) => {
    const stream = createWriteStream(path, { flags: "a" });
    const write = (type: string, connection: ConnectionInfo | undefined, data: Record<string, unknown>) => {
      const where = { monitor: monitor.id, ...(connection ? { connection: connection.id } : {}) };
      stream.write(`${JSON.stringify({ at: new Date().toISOString(), type, ...where, ...data })}\n`);
    };
    const view = (item: Item) => ({
      id: item.id,
      ...(item.author ? { author: item.author.name } : {}),
      ...(includeText ? { text: item.text } : {}),
    });

    monitor.on("judged", (e) =>
      write("judged", e.connection, { item: view(e.item), answers: e.answers, latencyMs: e.latencyMs, usage: e.usage, cached: e.cached }),
    );
    monitor.on("review", (e) => write("review", e.connection, { item: view(e.item), trigger: e.trigger, handler: e.handler }));
    monitor.on("action", (e) =>
      write("action", e.event.connection, {
        item: view(e.event.item),
        action: e.action,
        description: e.description,
        status: e.status,
        reason: e.reason,
        trigger: e.event.trigger,
      }),
    );
    monitor.on("dropped", (e) => write("dropped", e.connection, { item: view(e.item), reason: e.reason }));
    monitor.on("error", (e) =>
      write("error", e.connection, {
        phase: e.phase,
        message: e.error instanceof Error ? e.error.message : String(e.error),
        ...(e.item ? { item: view(e.item) } : {}),
      }),
    );

    return () => new Promise<void>((resolve) => stream.end(resolve));
  };
}
