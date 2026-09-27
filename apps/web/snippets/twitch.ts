import { burst, monitor, recipes } from "jev-events";
import { twitch } from "@jev-events/twitch";

const mods = monitor({
  source: twitch.chat(),
  questions: { hateful: recipes.chat.hateful, spam: recipes.chat.spam, streamIssue: recipes.chat.streamIssue },
})
  .on("hateful", { min: 0.9 }, twitch.timeout({ seconds: 600 }))
  .on("spam", { min: 0.85 }, twitch.deleteMessage())
  .on(
    "streamIssue",
    // Three different viewers within 45 seconds, not one viewer three times.
    burst({ count: 3, within: "45s", distinctBy: (e) => e.item.author.id }, ({ last }) => {
      console.warn(`Chat says the stream has a problem: "${last.item.text}"`);
    }),
  );

// Reads the channel of the account `npx jev-events auth twitch` saved, over EventSub.
await mods.start();
