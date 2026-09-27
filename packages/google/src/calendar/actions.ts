import { defineAction, type ActionContext } from "jev-events";

import type { CalendarEvent, CalendarItem, Rsvp } from "./item.js";
import type { CalendarSession } from "./source.js";

export interface RespondOptions {
  /** A note to the organizer, shown with your answer. */
  comment?: string;
}

/** The answers `respond()` can give. */
export type Answer = Exclude<Rsvp, "pending">;

const STATUS = { accepted: "accepted", declined: "declined", maybe: "tentative" } as const;
const VERB: Record<Answer, string> = { accepted: "accept", declined: "decline", maybe: "answer maybe to" };

function sessionOf(ctx: ActionContext<CalendarSession>): CalendarSession {
  if (!ctx.session?.api) throw new Error("Calendar actions run on items from google.calendar.events() or google.calendar.invites().");
  return ctx.session;
}

/**
 * Answer the invite: "accepted", "declined" or "maybe". The organizer is told. For a recurring
 * event, the answer covers every occurrence.
 */
export function respond(answer: Answer, options: RespondOptions = {}) {
  const status = STATUS[answer];
  if (!status) throw new Error(`respond() takes "accepted", "declined" or "maybe", not ${JSON.stringify(answer)}.`);
  return defineAction<"google-calendar", CalendarItem, CalendarSession>({
    platform: "google-calendar",
    name: `calendar.${answer === "accepted" ? "accept" : answer === "declined" ? "decline" : "maybe"}`,
    describe: (e) => `${VERB[answer]} "${e.item.title}"${e.item.recurring ? " (every occurrence)" : ""}${options.comment ? " with a note" : ""}`,
    async run(e, ctx) {
      const { api, me } = sessionOf(ctx);
      const path = `/calendars/${encodeURIComponent(e.item.calendarId)}/events/${encodeURIComponent(e.item.eventId)}`;
      const event = await api.calendar<CalendarEvent>("GET", path);
      if (event.organizer?.self) throw new Error(`You organized "${e.item.title}", so there's no invite to answer.`);
      const you = event.attendees?.find((a) => a.self) ?? event.attendees?.find((a) => a.email?.toLowerCase() === me);
      if (!you?.email) throw new Error(`You're not on the guest list of "${e.item.title}".`);
      // Only your own answer is sent; the rest of the guest list is left as it is.
      await api.calendar("PATCH", path, {
        query: { sendUpdates: "all" },
        body: {
          attendeesOmitted: true,
          attendees: [{ email: you.email, responseStatus: status, ...(options.comment ? { comment: options.comment } : {}) }],
        },
      });
    },
  });
}

/** Say yes to the invite. The organizer is told. Same as `respond("accepted")`. */
export function accept(options?: RespondOptions) {
  return respond("accepted", options);
}

/** Say no to the invite. The event stays on the calendar, marked declined, and the organizer is told. */
export function decline(options?: RespondOptions) {
  return respond("declined", options);
}

/** Answer maybe. The organizer is told. */
export function maybe(options?: RespondOptions) {
  return respond("maybe", options);
}
