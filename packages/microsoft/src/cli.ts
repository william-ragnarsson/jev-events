import { recipes } from "jev-events";

import { fromEnv } from "./auth.js";
import { events } from "./calendar/source.js";
import { inbox } from "./outlook/source.js";
import { messages } from "./teams/source.js";

/** The account MICROSOFT_CLIENT_ID and MICROSOFT_REFRESH_TOKEN name, when they're set. */
const envAccount = () => (process.env.MICROSOFT_REFRESH_TOKEN ? fromEnv() : undefined);

/**
 * `jev-events watch outlook[:folder]`, `jev-events watch outlook-calendar` and
 * `jev-events watch teams[:chat,chat]`, reading the accounts saved by `jev-events auth microsoft`,
 * or the one MICROSOFT_REFRESH_TOKEN names when set. The CLI loads this only when you watch one of
 * these.
 */
export const cli = {
  outlook: {
    source: (target: string) => inbox({ backfill: 5, ...(target ? { folder: target } : {}) }),
    questions: { needsReply: recipes.email.needsReply, urgent: recipes.email.urgent, kind: recipes.email.kind },
    connected: "Showing your 5 latest emails, then new mail as it arrives (checked every 15s).",
    account: "your Microsoft account",
    fromEnv: envAccount,
  },
  "outlook-calendar": {
    source: () => events({ backfill: 5 }),
    questions: { important: recipes.calendar.important, needsPrep: recipes.calendar.needsPrep },
    connected: "Showing your next 5 events, then new and changed ones as they come in (checked every 30s).",
    account: "your Microsoft account",
    fromEnv: envAccount,
  },
  teams: {
    source: (target: string) => messages({ backfill: 5, ...(target ? { chats: target.split(",") } : {}) }),
    questions: { needsAnswer: recipes.team.needsAnswer, urgent: recipes.team.urgent, kind: recipes.team.kind },
    connected: "Showing the 5 latest messages in your chats, then new ones as they're written (checked every 10s).",
    account: "a work or school Microsoft account",
    fromEnv: envAccount,
  },
};
