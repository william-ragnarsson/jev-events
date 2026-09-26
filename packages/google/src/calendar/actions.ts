import { defineAction } from "jev-events";

import type { CalendarEvent, CalendarItem } from "./item.js";
import type { CalendarSession, CalendarSource } from "./source.js";

export interface RespondOptions {
  /** A note to the organizer, shown with your answer. */
  comment?: string;
}

function sessionOf(source: CalendarSource): CalendarSession {
  if (!source.session) throw new Error("Calendar actions need the Calendar source: google.calendar.events({ auth }).");
  return source.session;
}

function respond(name: string, verb: string, status: "accepted" | "declined" | "tentative", options: RespondOptions = {}) {
  return defineAction<"google-calendar", CalendarItem, CalendarSource>({
    platform: "google-calendar",
    name: `calendar.${name}`,
    describe: (e) => `${verb} "${e.item.title}"${e.item.recurring ? " (every occurrence)" : ""}${options.comment ? " with a note" : ""}`,
    async run(e, source) {
      const { api } = sessionOf(source);
      const path = `/calendars/${encodeURIComponent(e.item.calendarId)}/events/${encodeURIComponent(e.item.eventId)}`;
      const event = await api.calendar<CalendarEvent>("GET", path);
      if (event.organizer?.self) throw new Error(`You organized "${e.item.title}", so there's no invite to answer.`);
      const you = event.attendees?.find((a) => a.self);
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

/** Say yes to the invite. The organizer is told. */
export function accept(options?: RespondOptions) {
  return respond("accept", "accept", "accepted", options);
}

/** Say no to the invite. The event stays on the calendar, marked declined, and the organizer is told. */
export function decline(options?: RespondOptions) {
  return respond("decline", "decline", "declined", options);
}

/** Answer maybe. The organizer is told. */
export function maybe(options?: RespondOptions) {
  return respond("maybe", "answer maybe to", "tentative", options);
}
