import { monitor, recipes } from "jev-events";
import { twitchChat } from "jev-events/public";

// Reading a public chat needs no Twitch account. Pick any live channel.
const chat = monitor({
  source: twitchChat("some_live_channel"),
  questions: { kind: recipes.chat.kind, hateful: recipes.chat.hateful },
})
  .on("kind:question", (e) => console.log(`❓ ${e.item.author.name}: ${e.item.text}`))
  .on("hateful", { min: 0.9 }, (e) => console.log(`🚫 ${e.item.author.name} (${e.trigger.probability})`));

await chat.start();
