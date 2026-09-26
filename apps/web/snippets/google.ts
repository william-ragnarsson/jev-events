import { listen, recipes } from "jev-events";
import { google } from "@jev-events/google";
// @hide-start
declare function notify(message: string): void;
// @hide-end

// `npx jev-events auth google` signs you in and saves the tokens.
const auth = google.auth.fromFile();

// The meetings that matter, out of everything on the calendar.
const calendar = listen(google.calendar.events({ auth }), {
  important: recipes.calendar.important,
  likelySales: recipes.calendar.likelySales,
});

calendar
  .on("important", { min: 0.8 }, (e) => notify(`Don't miss "${e.item.title}"`))
  .on("likelySales", { min: 0.9 }, google.calendar.decline({ comment: "Thanks, but I'll pass." }));

// Newsletters out of the inbox, and a label on mail that needs a reply.
const mail = listen(google.gmail.inbox({ auth }), {
  kind: recipes.email.kind,
  needsReply: recipes.email.needsReply,
});

mail
  .on("kind:newsletter", { min: 0.9 }, google.gmail.archive())
  .on("needsReply", { min: 0.8 }, google.gmail.label("Needs reply"));

await Promise.all([calendar.start(), mail.start()]);
