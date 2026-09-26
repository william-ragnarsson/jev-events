import { recipes } from "jev-events";

import { fromFile } from "./auth.js";
import { events } from "./calendar/source.js";
import { inbox } from "./gmail/source.js";

/**
 * `jev-events watch gmail` and `jev-events watch calendar[:calendarId]`, using the account saved by
 * `jev-events auth google`. The CLI loads this only when you watch one of these.
 */
export const cli = {
  gmail: {
    source: () => inbox({ auth: fromFile(), backfill: 5 }),
    questions: { needsReply: recipes.email.needsReply, urgent: recipes.email.urgent, kind: recipes.email.kind },
    connected: "Showing your 5 latest emails, then new mail as it arrives (checked every 15s).",
  },
  calendar: {
    source: (target: string) => events({ auth: fromFile(), calendarId: target || "primary", backfill: 5 }),
    questions: { important: recipes.calendar.important, needsPrep: recipes.calendar.needsPrep },
    connected: "Showing your next 5 events, then new and changed ones as they come in (checked every 30s).",
  },
};
