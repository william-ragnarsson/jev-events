import { from, listen, noul, webhook } from "jev-events";
// @hide-start
declare const logLines: AsyncIterable<string>;
declare function page(text: string): Promise<void>;
declare function escalate(text: string): Promise<void>;
// @hide-end

// Any async iterable: log lines, a queue, a database cursor.
const logs = listen(from(logLines, { noun: "line" }), {
  outage: noul("Does this log line describe a failure a human should look at?"),
});
logs.on("outage", { min: 0.8 }, (e) => page(e.item.text));

// Or anything that can send a webhook.
const secret = process.env.WEBHOOK_SECRET;
const tickets = listen(webhook({ port: 8787, secret }), {
  angry: noul("Is the customer angry?"),
});
tickets.on("angry", { min: 0.7 }, (e) => escalate(e.item.text));

await Promise.all([logs.start(), tickets.start()]);
