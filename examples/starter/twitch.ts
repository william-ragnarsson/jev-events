// A live Twitch chat, read without a Twitch account. Needs only TYPESAFE_API_KEY.
// Run: npm run twitch -- <a channel that is live right now>
import { choice, monitor } from "jev-events";
import { twitchChat } from "jev-events/public";

const channel = process.argv[2];
if (!channel) {
  console.error("Name a live channel: npm run twitch -- <channel>");
  process.exit(1);
}
if (!process.env.TYPESAFE_API_KEY) {
  console.error("Put TYPESAFE_API_KEY in .env first (see README.md).");
  process.exit(1);
}

const chat = monitor({
  source: twitchChat(channel),
  questions: {
    // Jev picks exactly one of these labels for each message.
    kind: choice("What is this chat message mainly doing?", {
      question: "Asks the streamer a question",
      hype: "Cheers or reacts with excitement",
      other: null,
    }),
  },
  // Big chats are fast, and each judged message is one paid request, so judge at most two a second.
  // Messages that wait more than 10 seconds are skipped.
  rate: { perSecond: 2, burst: 2 },
});

// Runs for every message Jev judged, so you can see it working.
chat.on("judged", (e) => console.log(`${e.answers.kind.choice.padEnd(8)} ${e.item.author.name}: ${e.item.text}`));

// Runs only for messages Jev labelled "question". Your own code goes here.
chat.on("kind:question", (e) => console.log(`         ↳ question for the streamer from ${e.item.author.name}`));

chat.on("error", (e) => console.error(String(e.error)));

await chat.start();
console.log(`Reading #${channel}. If nothing shows up, check that twitch.tv/${channel} is live. Stop with Ctrl+C.`);
