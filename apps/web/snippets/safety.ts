import { listen, logTo, recipes } from "jev-events";
import { twitch } from "@jev-events/twitch";

const chat = listen(
  twitch.chat("mychannel", { auth: twitch.auth.fromFile() }),
  { hateful: recipes.chat.hateful },
  {
    dryRun: true, // the default: log what would happen
    budget: { inputTokensPerDay: 20_000_000 }, // ≈ $0.84 a day
    rate: { perSecond: 10 }, // requests per second, at most
    maxLagMs: 10_000, // too old to matter? skip it
  },
);

chat
  .on("hateful", { min: 0.9, review: 0.6 }, twitch.timeout())
  .use(logTo("moderation.jsonl")); // every answer and action

await chat.start();
