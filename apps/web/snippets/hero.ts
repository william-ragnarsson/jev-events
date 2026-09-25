import { choice, listen, recipes } from "jev-events";
import { twitch } from "@jev-events/twitch";
// @hide-start
declare const overlay: { push(text: string): void };
declare const modQueue: { add(event: unknown): void };
// @hide-end

const chat = listen(twitch.chat("mychannel", { auth: twitch.auth.fromFile() }), {
  kind: choice("What is this chat message doing?", {
    question: "Asks the streamer something",
    spoiler: "Reveals story or boss details",
    other: null,
  }),
  hateful: recipes.chat.hateful,
});

chat.on("hateful", { min: 0.9, review: 0.6 }, twitch.timeout({ seconds: 600 }));
chat.on("kind:spoiler", twitch.deleteMessage());
chat.on("kind:question", (e) => overlay.push(e.item.text)); // your own code
chat.on("review", (e) => modQueue.add(e)); // unsure? a human decides

await chat.start(); // native actions are dry-run until { dryRun: false }
