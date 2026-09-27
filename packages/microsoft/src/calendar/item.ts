import type { Author, Item, JsonValue } from "jev-events";

import type { GraphBody, GraphRecipient } from "../outlook/message.js";
import type { Person } from "../protect.js";
import { htmlToText, truncate } from "../text.js";

/** An event as Graph returns it. Times are in UTC. */
export interface GraphEvent {
  id: string;
  /** Occurrences and exceptions belong to a series, whose id is `seriesMasterId`. */
  type?: "singleInstance" | "occurrence" | "exception" | "seriesMaster";
  seriesMasterId?: string | null;
  subject?: string | null;
  body?: GraphBody;
  bodyPreview?: string;
  start?: GraphTime;
  end?: GraphTime;
  isAllDay?: boolean;
  location?: { displayName?: string | null } | null;
  organizer?: GraphRecipient | null;
  attendees?: GraphAttendee[];
  isOrganizer?: boolean;
  /** Whether the organizer asked for answers. */
  responseRequested?: boolean;
  /** The signed-in user's answer. */
  responseStatus?: { response?: GraphResponse };
  isCancelled?: boolean;
  /** "free" when the event doesn't block time. */
  showAs?: "free" | "tentative" | "busy" | "oof" | "workingElsewhere" | "unknown";
  /** The pattern and range, on a series. */
  recurrence?: unknown;
  onlineMeeting?: { joinUrl?: string | null } | null;
  onlineMeetingUrl?: string | null;
  webLink?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  /** Set on delta results for events that were deleted or moved out of the followed window. */
  "@removed"?: { reason?: string };
}

export type GraphResponse = "none" | "organizer" | "tentativelyAccepted" | "accepted" | "declined" | "notResponded";

export interface GraphAttendee extends GraphRecipient {
  /** "resource" is a room or equipment, not a person. */
  type?: "required" | "optional" | "resource";
  status?: { response?: GraphResponse };
}

export interface GraphTime {
  /** "2026-10-01T09:00:00.0000000", without an offset. */
  dateTime?: string;
  timeZone?: string;
}

/** An answer to an invite. "pending" means not answered yet. */
export type Rsvp = "accepted" | "declined" | "maybe" | "pending";

/** Why the event was emitted: it's new to the calendar, it changed, or it was already there (`backfill`). */
export type EventChange = "new" | "updated" | "existing";

export interface Attendee {
  email: string;
  name?: string;
  response: Rsvp;
  optional: boolean;
  organizer: boolean;
  /** The signed-in user. */
  you: boolean;
}

/** One calendar event, as the Outlook Calendar sources emit it. */
export interface OutlookCalendarItem extends Item<GraphEvent> {
  /** The organizer. `id` and `email` are their address. */
  author: Author & { email: string };
  /** The event accept, decline and maybe answer. For a recurring event, that's the whole series. */
  eventId: string;
  title: string;
  /** The description as plain text, capped at 2,000 characters. */
  description: string;
  /** For a recurring event, the next occurrence. */
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
  /** Teams, Zoom, Google Meet or another video link. */
  meetingLink?: string;
  organizer: { email: string; name?: string; you: boolean };
  /** Invited people. Rooms are left out. */
  attendees: Attendee[];
  /** Your answer, when you're invited. */
  yourResponse?: Rsvp;
  recurring: boolean;
  /** Opens the event in Outlook on the web. */
  link?: string;
  change: EventChange;
  /** For an invite: the events you're going to at the same time, by title. */
  clashesWith?: string[];
  /** Why native actions skip this event, e.g. "colleague at acme.com". */
  protectedBecause?: string;
}

export interface OutlookCalendarItemContext {
  /** The signed-in address. */
  me: string;
  /** Your time zone, for all-day events and the `starts` fact. */
  timeZone: string;
  change: EventChange;
  /** The event that actions answer, when it isn't `event.id`: the series, for one of its occurrences. */
  eventId?: string;
  /** Tells this version of the event apart from earlier ones. Default: when it was last modified. */
  version?: string;
  /** What the account knows about the organizer. */
  organizer?: Person;
  /** Titles of the events you're going to that overlap this one. */
  clashesWith?: string[];
  protectedBecause?: string;
  now?: Date;
}

const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_LISTED_ATTENDEES = 10;
const RSVP: Record<string, Rsvp> = {
  accepted: "accepted",
  declined: "declined",
  tentativelyAccepted: "maybe",
  notResponded: "pending",
  none: "pending",
};
const VIDEO_LINK = /https?:\/\/[^\s<>"]*(zoom\.us|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|webex\.com|whereby\.com|around\.co)[^\s<>"]*/i;
const HOUR_MS = 3_600_000;

/** Turn a Graph event into an item, with times worked out and account facts about the organizer. */
export function outlookCalendarItem(event: GraphEvent, context: OutlookCalendarItemContext): OutlookCalendarItem {
  const now = context.now ?? new Date();
  const me = context.me.toLowerCase();
  const allDay = event.isAllDay === true;
  const start = startOf(event, context.timeZone) ?? now;
  const end = endOf(event, context.timeZone) ?? start;
  const title = event.subject?.trim() || "(no title)";
  const description = truncate(descriptionOf(event), MAX_DESCRIPTION_CHARS);
  const location = event.location?.displayName?.trim() || undefined;
  const meetingLink = meetingLinkOf(event);
  const recurring = Boolean(event.seriesMasterId || event.recurrence || event.type === "occurrence" || event.type === "exception");

  const host = event.organizer?.emailAddress ?? {};
  const organizerEmail = (host.address?.trim() || "unknown").toLowerCase();
  const organizerName = host.name?.trim() && host.name.trim().toLowerCase() !== organizerEmail ? host.name.trim() : undefined;
  const organizer = {
    email: organizerEmail,
    ...(organizerName ? { name: organizerName } : {}),
    you: event.isOrganizer === true || organizerEmail === me,
  };
  const attendees: Attendee[] = (event.attendees ?? [])
    .filter((a) => a.type !== "resource" && a.emailAddress?.address)
    .map((a) => {
      const email = (a.emailAddress?.address as string).trim().toLowerCase();
      const name = a.emailAddress?.name?.trim();
      return {
        email,
        ...(name && name.toLowerCase() !== email ? { name } : {}),
        response: RSVP[a.status?.response ?? "none"] ?? "pending",
        optional: a.type === "optional",
        organizer: email === organizerEmail,
        you: email === me,
      };
    });
  // Your own answer is on the event; the guest list may not have caught up with it. An event with no
  // guests is a block on your calendar, not an invite.
  const own = event.responseStatus?.response;
  const invited = !organizer.you && attendees.length > 0;
  const yourResponse = !invited ? undefined : own && own !== "organizer" ? RSVP[own] : attendees.find((a) => a.you)?.response;
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);

  const facts: Record<string, JsonValue> = {
    starts: formatStart(start, allDay, context.timeZone),
    startsIn: until(start, now, allDay),
    ...(allDay ? { days: Math.max(1, Math.round(minutes / 1_440)) } : { durationMinutes: minutes }),
    change: context.change,
    organizer: organizer.you ? "you" : formatPerson(organizer),
    attendeeCount: attendees.length,
    recurring,
    hasMeetingLink: meetingLink !== undefined,
  };
  if (location) facts.location = location;
  if (yourResponse) facts.yourResponse = yourResponse;
  if (context.clashesWith?.length) facts.clashesWith = context.clashesWith;
  if (context.organizer && !organizer.you) {
    facts.organizerIsColleague = context.organizer.colleague;
    if (context.organizer.emailedBefore !== undefined) facts.organizerEmailedBefore = context.organizer.emailedBefore;
  }

  const eventId = context.eventId ?? event.id;
  return {
    id: `${eventId}:${context.version ?? event.lastModifiedDateTime ?? ""}`,
    text: `${title}\n${facts.starts as string}${description ? `\n\n${description}` : ""}`,
    author: { id: organizerEmail, name: organizerName ?? organizerEmail, email: organizerEmail },
    at: new Date(event.lastModifiedDateTime ?? event.createdDateTime ?? now),
    facts,
    raw: event,
    eventId,
    title,
    description,
    start,
    end,
    allDay,
    ...(location ? { location } : {}),
    ...(meetingLink ? { meetingLink } : {}),
    organizer,
    attendees,
    ...(yourResponse ? { yourResponse } : {}),
    recurring,
    ...(event.webLink ? { link: event.webLink } : {}),
    change: context.change,
    ...(context.clashesWith?.length ? { clashesWith: context.clashesWith } : {}),
    ...(context.protectedBecause ? { protectedBecause: context.protectedBecause } : {}),
  };
}

/** What Jev sees: the title, description, when, who's organizing and who's invited. */
export function describeEvent(item: OutlookCalendarItem): JsonValue {
  const listed = item.attendees.filter((a) => !a.organizer).slice(0, MAX_LISTED_ATTENDEES).map(formatPerson);
  const more = item.attendees.filter((a) => !a.organizer).length - listed.length;
  return {
    title: item.title,
    ...(item.description ? { description: item.description } : {}),
    ...item.facts,
    ...(listed.length > 0 ? { attendees: more > 0 ? [...listed, `and ${more} more`] : listed } : {}),
  };
}

function formatPerson(person: { email: string; name?: string; you?: boolean }): string {
  if (person.you) return "you";
  return person.name ? `${person.name} <${person.email}>` : person.email;
}

function descriptionOf(event: GraphEvent): string {
  const content = event.body?.content ?? "";
  const text = event.body?.contentType?.toLowerCase() === "html" ? htmlToText(content) : content.replace(/\r\n?/g, "\n").trim();
  return text || event.bodyPreview?.trim() || "";
}

function meetingLinkOf(event: GraphEvent): string | undefined {
  const link = event.onlineMeeting?.joinUrl ?? event.onlineMeetingUrl;
  if (link) return link;
  return VIDEO_LINK.exec(event.location?.displayName ?? "")?.[0] ?? VIDEO_LINK.exec(event.body?.content ?? event.bodyPreview ?? "")?.[0];
}

/** When the event starts. All-day events start at midnight in your time zone. */
export function startOf(event: GraphEvent, timeZone: string): Date | undefined {
  return timeOf(event.start, event.isAllDay === true, timeZone);
}

/** When the event ends. All-day events end at midnight after their last day. */
export function endOf(event: GraphEvent, timeZone: string): Date | undefined {
  return timeOf(event.end ?? event.start, event.isAllDay === true, timeZone);
}

function timeOf(time: GraphTime | undefined, allDay: boolean, timeZone: string): Date | undefined {
  const dateTime = time?.dateTime;
  if (!dateTime) return undefined;
  const instant = new Date(/(z|[+-]\d\d:\d\d)$/i.test(dateTime) ? dateTime : `${dateTime}Z`);
  if (Number.isNaN(instant.getTime())) return undefined;
  if (!allDay) return instant;
  // An all-day event is midnight to midnight where it was made, so in UTC it can start the evening
  // before. The nearest midnight in your time zone gives back its day.
  const date = /T00:00:00(\.0+)?$/.test(dateTime)
    ? dateTime.slice(0, 10)
    : new Date(instant.getTime() + offsetOf(instant.getTime(), timeZone) + 12 * HOUR_MS).toISOString().slice(0, 10);
  return atMidnight(date, timeZone);
}

/** Midnight at the start of `date` ("2026-09-30") in a time zone. */
export function atMidnight(date: string, timeZone: string): Date {
  const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  const utc = Date.UTC(year, month - 1, day);
  const first = utc - offsetOf(utc, timeZone);
  // Around a daylight-saving change the offset at midnight can differ from the one at UTC midnight.
  return new Date(utc - offsetOf(first, timeZone));
}

/** How far ahead of UTC a time zone is at an instant, in milliseconds. */
function offsetOf(at: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }).formatToParts(new Date(at));
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return local - Math.floor(at / 1_000) * 1_000;
  } catch {
    return 0; // unknown time zone: treat as UTC
  }
}

function formatStart(start: Date, allDay: boolean, timeZone: string): string {
  const date: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric" };
  const options: Intl.DateTimeFormatOptions = allDay ? date : { ...date, hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  let zone = timeZone;
  let text: string;
  try {
    text = new Intl.DateTimeFormat("en-GB", { ...options, timeZone }).format(start);
  } catch {
    zone = "UTC";
    text = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: zone }).format(start);
  }
  return allDay ? `${text} (all day)` : `${text} (${zone})`;
}

/** "25 minutes", "3 hours", "2 days". Jev gets the time math done, not asked to do it. */
function until(start: Date, now: Date, allDay: boolean): string {
  const minutes = Math.round((start.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return allDay ? "today" : "already started";
  if (minutes < 90) return plural(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 36) return plural(hours, "hour");
  return plural(Math.round(hours / 24), "day");
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}
