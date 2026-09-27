import { choice, monitor, recipes } from "jev-events";
import { twitch } from "@jev-events/twitch";
// @hide-start
declare const overlay: { push(text: string): void };
declare const modQueue: { add(event: unknown): void };
// @hide-end

const mods = monitor({
  source: twitch.chat(), // your channel's chat, as you
  questions: {
    kind: choice("What is this chat message doing?", {
      question: "Asks the streamer something",
      spoiler: "Reveals story or boss details",
      other: null,
    }),
    hateful: recipes.chat.hateful,
  },
})
  .on("hateful", { min: 0.9, review: 0.6 }, twitch.timeout({ seconds: 600 }))
  .on("kind:spoiler", twitch.deleteMessage())
  .on("kind:question", (e) => overlay.push(e.item.text)) // your own code
  .on("review", (e) => modQueue.add(e)); // unsure? a human decides

await mods.start(); // native actions are dry-run until { dryRun: false }
