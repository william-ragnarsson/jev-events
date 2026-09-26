import { listen, recipes } from "jev-events";
import { slack } from "@jev-events/slack";

// `npx jev-events auth slack` connects your Slack app and saves its tokens.
const team = listen(slack.messages({ auth: slack.auth.fromFile() }), {
  urgent: recipes.team.urgent,
  needsAnswer: recipes.team.needsAnswer,
});

team
  // Outages and blockers, wherever they're mentioned, land in one channel.
  .on("urgent", { min: 0.9 }, slack.post("#incidents"))
  // Messages waiting on an answer get a reaction, so they're easy to spot.
  .on("needsAnswer", { min: 0.8 }, slack.react("eyes"));

await team.start();
