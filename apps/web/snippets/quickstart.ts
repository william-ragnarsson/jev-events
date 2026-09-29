import { monitor, recipes } from "jev-events";
import { twitchChat } from "jev-events/public";

const chat = monitor({
  source: twitchChat("some_live_channel"),
  questions: { kind: recipes.chat.kind, hateful: recipes.chat.hateful },
})
  .on("kind:question", (e) =>
    console.log(`[question] ${e.item.author.name}: ${e.item.text}`),
  )
  .on("hateful", { min: 0.9 }, (e) =>
    console.log(`[hateful] ${e.item.author.name} (${e.trigger.probability})`),
  );

await chat.start();
