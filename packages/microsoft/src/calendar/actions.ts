import { defineAction, type ActionContext } from "jev-events";

import type { GraphEvent, OutlookCalendarItem, Rsvp } from "./item.js";
import type { OutlookCalendarSession } from "./source.js";

export interface RespondOptions {
  /** A note to the organizer, sent with your answer. */
  comment?: string;
}

/** The answers `respond()` can give. */
export type Answer = Exclude<Rsvp, "pending">;

const ENDPOINT = { accepted: "accept", declined: "decline", maybe: "tentativelyAccept" } as const;
const VERB: Record<Answer, string> = { accepted: "accept", declined: "decline", maybe: "answer maybe to" };

function sessionOf(ctx: ActionContext<OutlookCalendarSession>): OutlookCalendarSession {
  if (!ctx.session?.api) throw new Error("Calendar actions run on items from microsoft.calendar.events() or microsoft.calendar.invites().");
  return ctx.session;
}

/**
 * Answer the invite: "accepted", "declined" or "maybe". The organizer is told, unless they didn't
 * ask for answers. For a recurring event, the answer covers every occurrence.
 */
export function respond(answer: Answer, options: RespondOptions = {}) {
  const endpoint = ENDPOINT[answer];
  if (!endpoint) throw new Error(`respond() takes "accepted", "declined" or "maybe", not ${JSON.stringify(answer)}.`);
  return defineAction<"outlook-calendar", OutlookCalendarItem, OutlookCalendarSession>({
    platform: "outlook-calendar",
    name: `outlook-calendar.${answer === "accepted" ? "accept" : answer === "declined" ? "decline" : "maybe"}`,
    describe: (e) => `${VERB[answer]} "${e.item.title}"${e.item.recurring ? " (every occurrence)" : ""}${options.comment ? " with a note" : ""}`,
    async run(e, ctx) {
      const { api } = sessionOf(ctx);
      const path = `/me/events/${encodeURIComponent(e.item.eventId)}`;
      const event = await api.call<GraphEvent>("GET", path, { query: { $select: "isOrganizer,responseRequested" } });
      if (event.isOrganizer) throw new Error(`You organized "${e.item.title}", so there's no invite to answer.`);
      await api.call("POST", `${path}/${endpoint}`, {
        body: { sendResponse: event.responseRequested !== false, ...(options.comment ? { comment: options.comment } : {}) },
      });
    },
  });
}

/** Say yes to the invite. The organizer is told. Same as `respond("accepted")`. */
export function accept(options?: RespondOptions) {
  return respond("accepted", options);
}

/** Say no to the invite. The organizer is told. */
export function decline(options?: RespondOptions) {
  return respond("declined", options);
}

/** Answer maybe. The organizer is told. */
export function maybe(options?: RespondOptions) {
  return respond("maybe", options);
}
