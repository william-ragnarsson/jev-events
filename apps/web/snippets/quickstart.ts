import { listen, recipes } from "jev-events";
import { twitch } from "@jev-events/twitch";

// Reading a public chat needs no Twitch login. Pick any live channel.
const chat = listen(twitch.chat("some_live_channel"), {
  kind: recipes.chat.kind,
  hateful: recipes.chat.hateful,
});

chat.on("kind:question", (e) => {
  console.log(`❓ ${e.item.author.name}: ${e.item.text}`);
});
// Dry-run: this only logs what it would do.
chat.on("hateful", { min: 0.9 }, twitch.timeout({ seconds: 600 }));

await chat.start();
