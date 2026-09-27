import { monitor, recipes } from "jev-events";
import { google } from "@jev-events/google";

// Newsletters out of the inbox, and a label on mail that needs a reply.
const mail = monitor({
  source: google.gmail.inbox(),
  questions: { kind: recipes.email.kind, needsReply: recipes.email.needsReply },
})
  .on("kind:newsletter", { min: 0.9 }, google.gmail.archive())
  .on("needsReply", { min: 0.8 }, google.gmail.label("Needs reply"));

// Invites you haven't answered: flag the ones that matter, turn down sales pitches.
const invites = monitor({
  source: google.calendar.invites(),
  questions: { important: recipes.calendar.important, likelySales: recipes.calendar.likelySales },
})
  .on("important", { min: 0.8 }, (e) => console.log(`Don't miss "${e.item.title}"`))
  .on("likelySales", { min: 0.9 }, google.calendar.decline({ comment: "Thanks, but I'll pass." }));

// Reads the account `npx jev-events auth google` saved, and checks every 15 and 30 seconds.
await Promise.all([mail.start(), invites.start()]);
