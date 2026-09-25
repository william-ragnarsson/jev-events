import { burst, listen, recipes } from "jev-events";
import { twitch } from "@jev-events/twitch";
// @hide-start
declare function alertStreamer(message: string): void;
// @hide-end

// `npx jev-events auth twitch` signs your bot in. Then /mod it in your channel.
const chat = listen(twitch.chat("mychannel", { auth: twitch.auth.fromFile() }), {
  hateful: recipes.chat.hateful,
  spam: recipes.chat.spam,
  streamIssue: recipes.chat.streamIssue,
});

chat
  .on("hateful", { min: 0.9 }, twitch.timeout({ seconds: 600 }))
  .on("spam", { min: 0.85 }, twitch.deleteMessage())
  .on(
    "streamIssue",
    // Three different viewers within 45 seconds, not one viewer three times.
    burst(
      { count: 3, within: "45s", distinctBy: (e) => e.item.author.id },
      () => alertStreamer("Chat reports a problem with the stream"),
    ),
  );

await chat.start();
