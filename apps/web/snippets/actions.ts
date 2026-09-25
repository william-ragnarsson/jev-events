import { defineAction, listen, recipes } from "jev-events";
import { twitch } from "@jev-events/twitch";
// @hide-start
declare const overlay: { push(text: string): void };
declare const db: { flag(userId: string, reason: string): Promise<void> };
// @hide-end

const chat = listen(
  twitch.chat("mychannel", { auth: twitch.auth.fromFile() }),
  { kind: recipes.chat.kind, hateful: recipes.chat.hateful },
);

// A built-in action: dry-run until you arm the listener,
// and never aimed at moderators or VIPs.
chat.on(
  "hateful",
  { min: 0.9 },
  twitch.timeout({ seconds: 600, reason: "Please keep chat kind" }),
);

// Your own function runs every time the outcome fires.
chat.on("kind:question", (e) => {
  overlay.push(`${e.item.author.name} asks: ${e.item.text}`);
});

// Your own action gets the same dry-run gate and protections as built-in ones.
const flagInDatabase = defineAction({
  platform: "*",
  name: "db.flag",
  describe: (e) => `flag ${e.item.author?.name ?? e.item.id} in the database`,
  run: (e) => db.flag(e.item.author?.id ?? e.item.id, e.trigger.event),
});
chat.on("kind:spam", { min: 0.85 }, flagInDatabase);

await chat.start();
