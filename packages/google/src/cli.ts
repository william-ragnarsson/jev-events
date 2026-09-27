import { recipes } from "jev-events";

import { fromEnv } from "./auth.js";
import { events } from "./calendar/source.js";
import { inbox } from "./gmail/source.js";

/** The account GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN name, when they're set. */
const envAccount = () => (process.env.GOOGLE_REFRESH_TOKEN ? fromEnv() : undefined);

/**
 * `jev-events watch gmail` and `jev-events watch calendar[:calendarId]`, reading the accounts saved
 * by `jev-events auth google`, or the one GOOGLE_REFRESH_TOKEN names when set. The CLI loads this
 * only when you watch one of these.
 */
export const cli = {
  gmail: {
    source: () => inbox({ backfill: 5 }),
    questions: { needsReply: recipes.email.needsReply, urgent: recipes.email.urgent, kind: recipes.email.kind },
    connected: "Showing your 5 latest emails, then new mail as it arrives (checked every 15s).",
    account: "your Google account",
    fromEnv: envAccount,
  },
  calendar: {
    source: (target: string) => events({ calendarId: target || "primary", backfill: 5 }),
    questions: { important: recipes.calendar.important, needsPrep: recipes.calendar.needsPrep },
    connected: "Showing your next 5 events, then new and changed ones as they come in (checked every 30s).",
    account: "your Google account",
    fromEnv: envAccount,
  },
};
