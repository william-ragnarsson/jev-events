#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { TypeSafeError } from "@typesafe-ai/sdk";

import { paint } from "./format.js";
import { UsageError, watch, type WatchFlags } from "./watch.js";

const HELP = `${paint(["bold", "magenta"], "jev-events")}: turn any stream into typed, semantic events, judged by TypeSafe's Jev

${paint("bold", "Usage")}
  jev-events watch <source> [questions] [options]
  jev-events auth twitch [--client-id <id>]

${paint("bold", "Sources")}
  twitch:<channel>         any public Twitch chat, no login needed
  bluesky[:word,word]      the Bluesky firehose, optionally only posts with these words
  stdin                    one item per line: tail -f app.log | jev-events watch stdin -a "..."
  webhook[:port]           POST {"text": "..."} to http://127.0.0.1:8787/

${paint("bold", "Questions")} (chat and posts get a sensible default)
  -a, --ask "label=Question?"          a yes/no question; repeatable
  -c, --choice "Question?" -o a,b,c    pick one of these labels
  -r, --recipe chat.hateful            a built-in question; repeatable

${paint("bold", "Options")}
  -f, --filter <regex>   only judge items that match
      --min <0-1>        yes/no answers count from this probability (default 0.5)
      --only             only print items where something fired
      --rate <n>         Jev requests per second (default 8)
      --context <n>      preceding items shown to Jev as context
      --lang <codes>     bluesky: only posts in these languages, e.g. en
  -m, --model <id>       Jev model (default jev-latest)
      --json             print JSON lines instead of a table
  -h, --help
  -v, --version

Set TYPESAFE_API_KEY first. Docs: https://jevevents.dev
`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ask: { type: "string", short: "a", multiple: true },
      choice: { type: "string", short: "c" },
      options: { type: "string", short: "o" },
      recipe: { type: "string", short: "r", multiple: true },
      filter: { type: "string", short: "f" },
      min: { type: "string" },
      only: { type: "boolean" },
      rate: { type: "string" },
      context: { type: "string" },
      lang: { type: "string" },
      model: { type: "string", short: "m" },
      json: { type: "boolean" },
      "client-id": { type: "string" },
      scopes: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.version) {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  const [command, target] = positionals;
  if (values.help || !command) {
    process.stdout.write(HELP);
    return;
  }

  switch (command) {
    case "watch":
      return watch(target, values as WatchFlags);
    case "auth":
      return auth(target, values);
    default:
      throw new UsageError(`Unknown command "${command}". Run jev-events --help.`);
  }
}

async function auth(platform: string | undefined, values: Record<string, unknown>): Promise<void> {
  const packages: Record<string, string> = { twitch: "@jev-events/twitch", google: "@jev-events/google", discord: "@jev-events/discord" };
  const name = packages[platform ?? ""];
  if (!name) throw new UsageError(`Usage: jev-events auth <${Object.keys(packages).join("|")}>`);
  let mod: { authorize?: (options: Record<string, unknown>) => Promise<void> };
  try {
    mod = (await import(name)) as typeof mod;
  } catch {
    throw new UsageError(`Install ${name} first: npm i ${name}`);
  }
  if (!mod.authorize) throw new UsageError(`${name} doesn't support "jev-events auth" yet.`);
  await mod.authorize(values);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${paint("red", "✖")} ${error.message}\n`);
    process.exit(2);
  }
  if (error instanceof TypeSafeError && /api key/i.test(error.message)) {
    process.stderr.write(
      `${paint("red", "✖")} Set TYPESAFE_API_KEY to your TypeSafe API key. Get one: https://docs.typesafe.ai/introduction/quickstart\n`,
    );
    process.exit(2);
  }
  process.stderr.write(`${paint("red", "✖")} ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
