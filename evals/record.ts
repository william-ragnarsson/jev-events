/**
 * Record public Twitch chat as raw material for new eval examples:
 *
 *   npm run eval:record -- <channel> [--count 300]
 *
 * Writes evals/datasets/raw/<channel>-<date>.jsonl, which is gitignored. Only the text, the
 * first-message flag and reply text are kept; names are dropped. Label the lines by hand, and
 * rewrite or remove anything that could identify a person, before adding them to a dataset.
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { silentLogger } from "jev-events";
import { twitchChat } from "jev-events/public";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { count: { type: "string", default: "300" } } });
const channel = positionals[0];
if (!channel) {
  process.stderr.write("Usage: npm run eval:record -- <channel> [--count 300]\n");
  process.exit(1);
}

const dir = join(fileURLToPath(new URL(".", import.meta.url)), "datasets", "raw");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${channel.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.jsonl`);
const out = createWriteStream(file, { flags: "a" });
const controller = new AbortController();
const limit = Number(values.count);
let recorded = 0;

await twitchChat(channel).start({
  signal: controller.signal,
  log: silentLogger,
  fail: (error) => process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`),
  end: () => {},
  emit(item) {
    if (recorded >= limit) return;
    out.write(
      `${JSON.stringify({
        id: `raw-${recorded + 1}`,
        text: item.text,
        lang: "",
        ...(item.firstMessage ? { firstMessage: true } : {}),
        ...(item.reply ? { reply: { author: "viewer", text: item.reply.text } } : {}),
      })}\n`,
    );
    recorded++;
    process.stderr.write(`\r${recorded}/${limit} messages from #${channel}`);
    if (recorded >= limit) {
      controller.abort();
      out.end(() => {
        process.stderr.write(`\nSaved to ${file}. Add lang and labels before using it.\n`);
        process.exit(0);
      });
    }
  },
});
