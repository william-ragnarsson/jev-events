import type { Author, Item, JsonValue } from "jev-events";

import type { Person } from "../protect.js";
import { htmlToText, truncate } from "../text.js";

/** An event as the Calendar API returns it. */
export interface CalendarEvent {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  htmlLink?: string;
  created?: string;
  updated?: string;
  summary?: string;
  description?: string;
  location?: string;
  creator?: CalendarPerson;
  organizer?: CalendarPerson;
  start?: EventTime;
  end?: EventTime;
  /** RRULE lines, on a recurring series. */
  recurrence?: string[];
  /** Set on one occurrence of a recurring series. */
  recurringEventId?: string;
  attendees?: CalendarAttendee[];
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  /** "default", "outOfOffice", "focusTime", "workingLocation", "birthday" or "fromGmail". */
  eventType?: string;
}

export interface CalendarPerson {
  email?: string;
  displayName?: string;
  /** The signed-in user. */
  self?: boolean;
}

export interface CalendarAttendee extends CalendarPerson {
  organizer?: boolean;
  /** A room or other resource, not a person. */
  resource?: boolean;
  optional?: boolean;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  comment?: string;
}

export interface EventTime {
  /** All-day events: "2026-09-30". */
  date?: string;
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

/** One calendar event, as the Calendar source emits it. */
export interface CalendarItem extends Item<CalendarEvent> {
  /** The organizer. `id` and `email` are their address. */
  author: Author & { email: string };
  /** The event accept, decline and maybe answer. For a recurring event, that's the whole series. */
  eventId: string;
  calendarId: string;
  title: string;
  /** The description as plain text, capped at 2,000 characters. */
  description: string;
  /** For a recurring event, the next occurrence. */
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
  /** Google Meet, Zoom, Teams or another video link. */
  meetingLink?: string;
  organizer: { email: string; name?: string; you: boolean };
  /** Invited people. Rooms are left out. */
  attendees: Attendee[];
  /** Your answer, when you're invited. */
  yourResponse?: Rsvp;
  recurring: boolean;
  /** Opens the event in Google Calendar. */
  link?: string;
  change: EventChange;
  /** Why native actions skip this event, e.g. "colleague at acme.com". */
  protectedBecause?: string;
}

export interface CalendarItemContext {
  calendarId: string;
  /** The signed-in address. */
  me: string;
  /** The calendar's time zone, for all-day events and the `starts` fact. */
  timeZone: string;
  change: EventChange;
  /** The event that actions answer, when it isn't `event.id` (a series, for one of its occurrences). */
  eventId?: string;
  /** Where the times come from, when it isn't `event`: the next occurrence of a series. */
  occurrence?: CalendarEvent;
  /** What the account knows about the organizer. */
  organizer?: Person;
  protectedBecause?: string;
  now?: Date;
}

const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_LISTED_ATTENDEES = 10;
const RSVP: Record<string, Rsvp> = { accepted: "accepted", declined: "declined", tentative: "maybe", needsAction: "pending" };
const VIDEO_LINK = /https?:\/\/[^\s<>"]*(zoom\.us|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|webex\.com|whereby\.com|around\.co)[^\s<>"]*/i;

/** Turn a Calendar event into an item, with times worked out and account facts about the organizer. */
export function calendarItem(event: CalendarEvent, context: CalendarItemContext): CalendarItem {
  const now = context.now ?? new Date();
  const me = context.me.toLowerCase();
  const times = context.occurrence ?? event;
  const allDay = times.start?.date !== undefined;
  const start = timeOf(times.start, context.timeZone) ?? now;
  const end = timeOf(times.end, context.timeZone) ?? start;
  const title = event.summary?.trim() || "(no title)";
  const description = truncate(plainDescription(event.description ?? ""), MAX_DESCRIPTION_CHARS);
  const location = event.location?.trim() || undefined;
  const meetingLink = meetingLinkOf(event);
  const recurring = Boolean(event.recurrence?.length || event.recurringEventId);

  const host = event.organizer ?? event.creator ?? {};
  const organizerEmail = (host.email ?? "unknown").toLowerCase();
  const organizer = {
    email: organizerEmail,
    ...(host.displayName ? { name: host.displayName } : {}),
    you: host.self === true || organizerEmail === me,
  };
  const attendees: Attendee[] = (event.attendees ?? [])
    .filter((a) => !a.resource && a.email)
    .map((a) => {
      const email = (a.email as string).toLowerCase();
      return {
        email,
        ...(a.displayName ? { name: a.displayName } : {}),
        response: RSVP[a.responseStatus ?? "needsAction"] ?? "pending",
        optional: a.optional === true,
        organizer: a.organizer === true || email === organizerEmail,
        you: a.self === true || email === me,
      };
    });
  const yourResponse = attendees.find((a) => a.you)?.response;
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
  if (context.organizer && !organizer.you) {
    facts.organizerIsColleague = context.organizer.colleague;
    if (context.organizer.emailedBefore !== undefined) facts.organizerEmailedBefore = context.organizer.emailedBefore;
  }

  return {
    id: `${event.id}:${event.updated ?? ""}`,
    text: `${title}\n${facts.starts as string}${description ? `\n\n${description}` : ""}`,
    author: { id: organizerEmail, name: host.displayName ?? organizerEmail, email: organizerEmail },
    at: new Date(event.updated ?? event.created ?? now),
    facts,
    raw: event,
    eventId: context.eventId ?? event.id,
    calendarId: context.calendarId,
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
    ...(event.htmlLink ? { link: event.htmlLink } : {}),
    change: context.change,
    ...(context.protectedBecause ? { protectedBecause: context.protectedBecause } : {}),
  };
}

/** What Jev sees: the title, description, when, who's organizing and who's invited. */
export function describeEvent(item: CalendarItem): JsonValue {
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

/** Calendar descriptions are HTML when written in Google Calendar, plain text otherwise. */
function plainDescription(description: string): string {
  return /<\/?[a-z][^>]*>/i.test(description) ? htmlToText(description) : description.replace(/\r\n?/g, "\n").trim();
}

function meetingLinkOf(event: CalendarEvent): string | undefined {
  if (event.hangoutLink) return event.hangoutLink;
  const video = event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri;
  if (video) return video;
  return VIDEO_LINK.exec(event.location ?? "")?.[0] ?? VIDEO_LINK.exec(event.description ?? "")?.[0];
}

function timeOf(time: EventTime | undefined, calendarTimeZone: string): Date | undefined {
  if (time?.dateTime) return new Date(time.dateTime);
  if (time?.date) return atMidnight(time.date, time.timeZone ?? calendarTimeZone);
  return undefined;
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
