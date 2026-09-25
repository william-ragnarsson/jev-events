/**
 * The service behind the live feed on the landing page.
 *
 *   TYPESAFE_API_KEY=... npm start                     serve /feed and /status on PORT (default 8790)
 *   TYPESAFE_API_KEY=... npm run record -- --minutes 10  record a replay for when the relay is offline
 *
 * Configuration (environment):
 *   LIVE_CHANNELS           channels to read, e.g. "channel_a,channel_b"
 *   TWITCH_CLIENT_ID        with TWITCH_CLIENT_SECRET: pick live channels from Twitch's directory
 *   TWITCH_CLIENT_SECRET
 *   BLOCKED_CHANNELS        never read these
 *   MAX_JUDGMENTS_PER_SEC   default 5; the rest of chat is skipped
 *   DAILY_TOKEN_BUDGET      input tokens per UTC day, default 40,000,000 (about $1.70)
 *   IDLE_DISCONNECT_SECONDS leave Twitch this long after the last viewer, default 60
 *   HIDE_AT                 hide messages at least this likely to be hateful, default 0.5
 *   ALLOWED_ORIGINS         origins that may read the feed, default "*"
 *   MAX_VIEWERS             feed connections at once, default 500
 */
import { createWriteStream } from "node:fs";
import { parseArgs } from "node:util";

import { createLogger, DailyBudget } from "jev-events";

import { fixedChannels, liveChannels, type ChannelPicker } from "./channels.js";
import { Relay, type FeedEntry } from "./relay.js";
import { createRelayServer } from "./server.js";

const env = process.env;
const log = createLogger((env.LOG_LEVEL as "debug" | "info" | "warn" | "error" | undefined) ?? "info");
const list = (value: string | undefined) => (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
const number = (value: string | undefined, fallback: number) => (value === undefined || value === "" ? fallback : Number(value));

const { values: args } = parseArgs({ options: { record: { type: "string" }, minutes: { type: "string", default: "10" } } });

if (args.record && /\/\/(localhost|127\.|\[::1\])/.test(env.TYPESAFE_BASE_URL ?? "")) {
  // The site presents a replay's latency and spend as measured, so it must come from the real Jev.
  log.error("Refusing to record a replay against a local TYPESAFE_BASE_URL such as the mock.");
  process.exit(1);
}

if (!env.TYPESAFE_API_KEY) {
  log.error("Set TYPESAFE_API_KEY. See https://docs.typesafe.ai/introduction/quickstart");
  process.exit(1);
}

const channels: ChannelPicker =
  env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET
    ? liveChannels({
        clientId: env.TWITCH_CLIENT_ID,
        clientSecret: env.TWITCH_CLIENT_SECRET,
        preferred: list(env.LIVE_CHANNELS),
        blocked: list(env.BLOCKED_CHANNELS),
      })
    : fixedChannels(list(env.LIVE_CHANNELS));
if (!(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET) && list(env.LIVE_CHANNELS).length === 0) {
  log.error("Set LIVE_CHANNELS (e.g. LIVE_CHANNELS=some_channel), or TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to pick live channels.");
  process.exit(1);
}

const relay = new Relay({
  channels,
  budget: new DailyBudget(number(env.DAILY_TOKEN_BUDGET, 40_000_000)),
  perSecond: number(env.MAX_JUDGMENTS_PER_SEC, 5),
  idleDisconnectMs: number(env.IDLE_DISCONNECT_SECONDS, 60) * 1000,
  hideAt: number(env.HIDE_AT, 0.5),
  log,
  ...(args.record ? { onEntry: recorder(args.record, Number(args.minutes)) } : {}),
});

if (args.record) {
  // Recording holds a viewer slot of its own, so the relay stays connected without a browser.
  relay.subscribe({ send() {} });
  log.info(`recording ${args.minutes} minutes of labeled chat to ${args.record}`);
} else {
  const port = number(env.PORT, 8790);
  const server = createRelayServer(relay, { allowedOrigins: list(env.ALLOWED_ORIGINS ?? "*"), maxViewers: number(env.MAX_VIEWERS, 500) });
  server.listen(port, () => log.info(`live relay on http://localhost:${port} (feed at /feed, status at /status)`));
  const shutdown = async () => {
    server.close();
    server.closeAllConnections();
    await relay.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

/** Write entries as JSONL with their offset from the start, then stop after `minutes`. */
function recorder(path: string, minutes: number) {
  const out = createWriteStream(path);
  const started = Date.now();
  let header = false;
  let count = 0;
  setTimeout(async () => {
    const status = relay.status();
    await relay.close();
    const summary = {
      type: "summary",
      durationMs: Date.now() - started,
      judged: count,
      inputTokens: status.today.inputTokens,
      spendUsd: status.today.spendUsd,
      latencyMs: status.latencyMs,
    };
    out.write(`${JSON.stringify(summary)}\n`);
    out.end(() => {
      log.info(`recorded ${count} messages to ${path}`);
      process.exit(0);
    });
  }, minutes * 60_000);
  return (entry: FeedEntry) => {
    if (!header) {
      const status = relay.status();
      out.write(`${JSON.stringify({ type: "meta", recordedAt: new Date(started).toISOString(), channel: status.stream?.channel ?? null, model: status.model })}\n`);
      header = true;
    }
    count++;
    out.write(`${JSON.stringify({ t: Date.now() - started, ...entry })}\n`);
  };
}
