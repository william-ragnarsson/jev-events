import { from, monitor, noul, webhook } from "jev-events";
// @hide-start
declare const logLines: AsyncIterable<string>;
declare function page(text: string): Promise<void>;
declare function escalate(text: string): Promise<void>;
// @hide-end

// Any async iterable: log lines, a queue, a database cursor.
const logs = monitor({
  source: from(logLines, { noun: "line" }),
  questions: { outage: noul("Does this log line describe a failure a human should look at?") },
}).on("outage", { min: 0.8 }, (e) => page(e.item.text));

// Or anything that can send a webhook: POST { "text": "…" } to http://127.0.0.1:8787.
const tickets = monitor({
  source: webhook({ port: 8787, secret: process.env.WEBHOOK_SECRET }),
  questions: { angry: noul("Is the customer angry?") },
}).on("angry", { min: 0.7 }, (e) => escalate(e.item.text));

await Promise.all([logs.start(), tickets.start()]);
