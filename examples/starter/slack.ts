// New messages in the Slack channels your app was invited to. Needs SLACK_BOT_TOKEN and SLACK_APP_TOKEN.
import { manifestUrl, slack } from "@jev-events/slack";
import { monitor, noul } from "jev-events";

if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
  console.log("Put SLACK_BOT_TOKEN and SLACK_APP_TOKEN in .env (see README.md).");
  console.log("This link makes the Slack app, with everything filled in:\n");
  console.log(manifestUrl());
  process.exit(0);
}
if (!process.env.TYPESAFE_API_KEY) {
  console.error("Put TYPESAFE_API_KEY in .env first (see README.md).");
  process.exit(1);
}

const team = monitor({
  // Also judge the 3 latest messages, so you see something straight away.
  source: slack.messages({ backfill: 3 }),
  questions: {
    // A yes/no question. Jev answers with how likely the answer is yes, from 0 to 1.
    needsAnswer: noul("Is someone waiting for an answer to this message?"),
  },
});

// Runs for every message Jev judged, so you can see it working.
team.on("judged", (e) =>
  console.log(`${e.answers.needsAnswer.noul.toFixed(2)}  ${e.item.facts?.channel} ${e.item.author.name}: ${e.item.text.replace(/\s+/g, " ")}`),
);

// Runs only when Jev is at least 80% sure. Your own code goes here.
team.on("needsAnswer", { min: 0.8 }, (e) => console.log(`      ↳ needs an answer: ${e.item.permalink ?? ""}`));

team.on("error", (e) => {
  console.error(String(e.error));
  // Slack no longer accepts a token, so stop instead of waiting for nothing.
  if (e.needsSignIn) {
    console.error("Check SLACK_BOT_TOKEN and SLACK_APP_TOKEN in .env.");
    process.exit(1);
  }
});

// fromEnv() reads the two tokens, which npm run loads from .env.
await team.start({ connections: [slack.fromEnv()] });
console.log("Watching Slack. Post in a channel the app is in. Stop with Ctrl+C.");
