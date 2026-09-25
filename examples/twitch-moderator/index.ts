/**
 * A Twitch chat moderator in ~40 lines.
 *
 *   npm start -- <channel>            dry-run: logs what it would do (works on any channel)
 *   ARMED=1 npm start -- <channel>    acts for real (needs `npx jev-events auth twitch`, bot = moderator)
 */
import { burst, listen, logTo, recipes } from "jev-events";
import { twitch, type TwitchAuth } from "@jev-events/twitch";

const channel = process.argv[2];
if (!channel) throw new Error("Usage: npm start -- <channel>");

let auth: TwitchAuth | undefined;
try {
  auth = twitch.auth.fromFile();
} catch {
  console.log("No Twitch sign-in found, so chat is read anonymously and actions stay in dry-run.");
}
const armed = process.env.ARMED === "1" && auth !== undefined;

const chat = listen(
  twitch.chat(channel, { auth }),
  { kind: recipes.chat.kind, hateful: recipes.chat.hateful, streamIssue: recipes.chat.streamIssue },
  { dryRun: !armed, context: { about: { channel, rules: ["Be kind", "No spoilers", "No self-promotion"] } } },
);

chat
  // Hate: time out and delete when sure; send the uncertain band to a human.
  .on("hateful", { min: 0.9, review: 0.6 }, twitch.timeout({ seconds: 600 }))
  .on("hateful", { min: 0.9 }, twitch.deleteMessage())
  .on("kind:spam", { min: 0.85 }, twitch.deleteMessage())
  // Your own code: surface questions for the streamer.
  .on("kind:question", { min: 0.7 }, (e) => console.log(`❓ ${e.item.author.name}: ${e.item.text}`))
  // Jev judges each message, code counts: three different people reporting a problem is a signal.
  .on(
    "streamIssue",
    burst({ count: 3, within: "45s", distinctBy: (e) => e.item.author.id }, (b) =>
      console.log(`🔧 ${b.events.length} viewers report a stream problem, e.g. "${b.last.item.text}"`),
    ),
  )
  .on("review", (e) => console.log(`👀 needs a human: ${e.item.author?.name}: ${e.item.text} (${e.trigger.event})`))
  .use(logTo("moderation.jsonl"));

await chat.start();
console.log(`Moderating #${channel} ${armed ? "(armed)" : "(dry-run)"}. Ctrl-C to stop.`);

process.on("SIGINT", async () => {
  await chat.stop();
  const stats = chat.stats();
  console.log(`\njudged ${stats.judged}, actions ${JSON.stringify(stats.actions)}, ≈ $${stats.estimatedCostUsd.toFixed(4)}`);
  process.exit(0);
});
