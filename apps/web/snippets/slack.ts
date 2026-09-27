import { monitor, recipes } from "jev-events";
import { slack } from "@jev-events/slack";

const team = monitor({
  source: slack.messages(),
  questions: { urgent: recipes.team.urgent, needsAnswer: recipes.team.needsAnswer },
})
  // Outages and blockers, wherever they're mentioned, land in one channel.
  .on("urgent", { min: 0.9 }, slack.post("#incidents"))
  // Messages waiting on an answer get a reaction, so they're easy to spot.
  .on("needsAnswer", { min: 0.8 }, slack.react("eyes"));

// Reads the workspace `npx jev-events auth slack` saved, over Socket Mode.
await team.start();
