/**
 * A Twitch chat moderator in ~50 lines.
 *
 *   npm start -- <channel>            dry-run: logs what it would do (works on any channel)
 *   ARMED=1 npm start -- <channel>    acts for real (after `npx jev-events auth twitch`, as a moderator there)
 */
import { burst, fileStore, logTo, monitor, recipes } from "jev-events";
import { twitchChat } from "jev-events/public";
import { twitch } from "@jev-events/twitch";

const channel = process.argv[2];
if (!channel) throw new Error("Usage: npm start -- <channel>");

// Signed in with `npx jev-events auth twitch`? Then chat is read as that account, which can act
// where it's a moderator. Otherwise it's read without an account, and actions stay in dry-run.
const store = fileStore();
const signedIn = (await store.connections.list({ integration: "twitch" })).some((connection) => connection.status === "active");
if (!signedIn) console.log("No Twitch sign-in found, so chat is read without one and actions stay in dry-run.");
const armed = process.env.ARMED === "1" && signedIn;

const mods = monitor({
  source: signedIn ? twitch.chat(channel) : twitchChat(channel),
  questions: { kind: recipes.chat.kind, hateful: recipes.chat.hateful, streamIssue: recipes.chat.streamIssue },
  dryRun: !armed,
  context: { about: { channel, rules: ["Be kind", "No spoilers", "No self-promotion"] } },
})
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
  .on("review", (e) => console.log(`👀 needs a human: ${e.item.author.name}: ${e.item.text} (${e.trigger.event})`))
  .use(logTo("moderation.jsonl"));

await mods.start({ store });
console.log(`Moderating #${channel} ${armed ? "(armed)" : "(dry-run)"}. Ctrl-C to stop.`);

process.on("SIGINT", async () => {
  await mods.stop();
  const stats = mods.stats();
  console.log(`\njudged ${stats.judged}, actions ${JSON.stringify(stats.actions)}, ≈ $${stats.estimatedCostUsd.toFixed(4)}`);
  process.exit(0);
});
