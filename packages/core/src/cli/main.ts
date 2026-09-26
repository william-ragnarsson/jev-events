#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { TypeSafeError } from "@typesafe-ai/sdk";

import { KEY_URL, loadEnv, readSecret } from "./env.js";
import { forThisShell, paint } from "./format.js";
import { UsageError, watch, type WatchFlags } from "./watch.js";

const HELP = `${paint(["bold", "magenta"], "jev-events")}: watch a stream, ask Jev about every item, see the answers live

${paint("bold", "Usage")}
  jev-events watch <source> [questions] [options]
  jev-events auth <google|slack|twitch>      connect an account once; saved in .jev-events/

${paint("bold", "Sources")}
  gmail                    new mail in your inbox (after: jev-events auth google)
  calendar                 new and changed events in your Google Calendar (after: jev-events auth google)
  slack[:channel]          messages in channels the Slack app is in (after: jev-events auth slack)
  twitch:<channel>         any public Twitch chat, no login needed
  bluesky[:word,word]      the Bluesky firehose, optionally only posts with these words
  stdin                    one item per line: tail -f app.log | jev-events watch stdin -a "..."
  webhook[:port]           POST {"text": "..."} to http://127.0.0.1:8787/

${paint("bold", "Questions")} (every source above except stdin and webhook has sensible defaults)
  -a, --ask "label=Question?"          a yes/no question; repeatable
  -c, --choice "Question?" -o a,b,c    pick one of these labels
  -r, --recipe email.urgent            a built-in question; repeatable

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

Needs a TypeSafe API key: put TYPESAFE_API_KEY=<key> in a .env file, or paste it when asked.
Docs: https://jevevents.dev
`;

async function main(argv: string[]): Promise<void> {
  loadEnv();
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
      "client-secret": { type: "string" },
      scopes: { type: "string" },
      token: { type: "string" },
      "app-token": { type: "string" },
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
  const packages: Record<string, string> = { google: "@jev-events/google", slack: "@jev-events/slack", twitch: "@jev-events/twitch" };
  const name = packages[platform ?? ""];
  if (!name) throw new UsageError(`Usage: jev-events auth <${Object.keys(packages).join("|")}>`);
  let mod: { authorize?: (options: Record<string, unknown>) => Promise<unknown> };
  try {
    mod = (await import(name)) as typeof mod;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND" && String(error).includes(name);
    if (!missing) throw error;
    throw new UsageError(`Install ${name} first: npm i ${name}`);
  }
  if (!mod.authorize) throw new UsageError(`${name} doesn't support "jev-events auth" yet.`);
  await mod.authorize({
    ...values,
    print: (line: string) => process.stdout.write(`${forThisShell(line)}\n`),
    ...(process.stdin.isTTY ? { askSecret: (question: string) => readSecret(question) } : {}),
  });
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${paint("red", "✖")} ${forThisShell(error.message)}\n`);
    process.exit(2);
  }
  if (error instanceof TypeSafeError && /api key/i.test(error.message)) {
    process.stderr.write(`${paint("red", "✖")} No TypeSafe API key found. Put TYPESAFE_API_KEY=<your key> in .env. Get one: ${KEY_URL}\n`);
    process.exit(2);
  }
  process.stderr.write(`${paint("red", "✖")} ${forThisShell(error instanceof Error ? error.message : String(error))}\n`);
  process.exit(1);
});
