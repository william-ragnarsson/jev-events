import { monitor, recipes } from "jev-events";
import { google } from "@jev-events/google";

const inbox = monitor({
  source: google.gmail.inbox(),
  questions: {
    kind: recipes.email.kind,
    needsReply: recipes.email.needsReply,
  },
})
  .on("kind:newsletter", { min: 0.9 }, google.gmail.archive())
  .on("needsReply", { min: 0.8 }, google.gmail.label("Needs reply"));

await inbox.start();
