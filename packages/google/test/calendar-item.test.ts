import { describe, expect, it } from "vitest";

import { calendarItem, describeEvent, type CalendarEvent, type CalendarItemContext, type Person } from "@jev-events/google";

import { atMidnight } from "../src/calendar/item.js";

const NOW = new Date("2026-09-28T08:00:00Z");
const CONTEXT: CalendarItemContext = { calendarId: "primary", me: "me@acme.com", timeZone: "Europe/Stockholm", change: "new", now: NOW };
const stranger: Person = { address: "ann@example.com", you: false, colleague: false, emailedBefore: false };
const MINUTE = 60_000;

/** Ann's invite to you, Wednesday 14:00–15:00 in Stockholm, with the parts a test changes. */
function invite(event: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e1",
    status: "confirmed",
    summary: "Budget review",
    start: { dateTime: "2026-09-30T14:00:00+02:00", timeZone: "Europe/Stockholm" },
    end: { dateTime: "2026-09-30T15:00:00+02:00", timeZone: "Europe/Stockholm" },
    organizer: { email: "ann@example.com", displayName: "Ann Smith" },
    attendees: [
      { email: "ann@example.com", displayName: "Ann Smith", organizer: true, responseStatus: "accepted" },
      { email: "me@acme.com", self: true, responseStatus: "needsAction" },
    ],
    ...event,
  };
}

/** A timed event starting `minutes` from NOW. */
function startingIn(minutes: number): Partial<CalendarEvent> {
  const start = NOW.getTime() + minutes * MINUTE;
  return { start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(start + 30 * MINUTE).toISOString() } };
}

describe("calendarItem", () => {
  it("reads everything a handler needs from an invite", () => {
    const event = invite({
      description: "<p>Q3 numbers.<br>Bring the <b>forecast</b>.</p>",
      location: "  Room 4 ",
      hangoutLink: "https://meet.google.com/abc-defg-hij",
      htmlLink: "https://calendar.google.com/event?eid=e1",
      created: "2026-09-20T09:00:00Z",
      updated: "2026-09-21T10:00:00Z",
      attendees: [
        { email: "Ann@Example.com", displayName: "Ann Smith", organizer: true, responseStatus: "accepted" },
        { email: "me@acme.com", self: true, responseStatus: "needsAction" },
        { email: "bob@example.com", responseStatus: "tentative", optional: true },
        { email: "room-4@resource.calendar.google.com", displayName: "Room 4", resource: true, responseStatus: "accepted" },
        { displayName: "No address" },
      ],
    });

    const item = calendarItem(event, { ...CONTEXT, organizer: { ...stranger, emailedBefore: true } });

    const starts = item.facts?.starts as string;
    expect(starts).toMatch(/^Wed,? 30 Sept? 2026,? 14:00 \(Europe\/Stockholm\)$/);
    expect(item).toEqual({
      id: "e1:2026-09-21T10:00:00Z",
      text: `Budget review\n${starts}\n\nQ3 numbers.\nBring the forecast.`,
      author: { id: "ann@example.com", name: "Ann Smith", email: "ann@example.com" },
      at: new Date("2026-09-21T10:00:00Z"),
      facts: {
        starts,
        startsIn: "2 days",
        durationMinutes: 60,
        change: "new",
        organizer: "Ann Smith <ann@example.com>",
        attendeeCount: 3,
        recurring: false,
        hasMeetingLink: true,
        location: "Room 4",
        yourResponse: "pending",
        organizerIsColleague: false,
        organizerEmailedBefore: true,
      },
      raw: event,
      eventId: "e1",
      calendarId: "primary",
      title: "Budget review",
      description: "Q3 numbers.\nBring the forecast.",
      start: new Date("2026-09-30T12:00:00Z"),
      end: new Date("2026-09-30T13:00:00Z"),
      allDay: false,
      location: "Room 4",
      meetingLink: "https://meet.google.com/abc-defg-hij",
      organizer: { email: "ann@example.com", name: "Ann Smith", you: false },
      attendees: [
        { email: "ann@example.com", name: "Ann Smith", response: "accepted", optional: false, organizer: true, you: false },
        { email: "me@acme.com", response: "pending", optional: false, organizer: false, you: true },
        { email: "bob@example.com", response: "maybe", optional: true, organizer: false, you: false },
      ],
      yourResponse: "pending",
      recurring: false,
      link: "https://calendar.google.com/event?eid=e1",
      change: "new",
    });
  });

  it("works out an all-day event in the calendar's time zone", () => {
    const item = calendarItem(invite({ start: { date: "2026-10-01" }, end: { date: "2026-10-03" } }), CONTEXT);

    expect(item).toMatchObject({ allDay: true, start: new Date("2026-09-30T22:00:00Z"), end: new Date("2026-10-02T22:00:00Z") });
    expect(item.facts).toMatchObject({ days: 2, startsIn: "3 days" });
    expect(item.facts).not.toHaveProperty("durationMinutes");
    expect(item.facts?.starts).toMatch(/^Thu,? 1 Oct 2026 \(all day\)$/);
  });

  it("says an all-day event that has begun is today", () => {
    const item = calendarItem(invite({ start: { date: "2026-09-28" }, end: { date: "2026-09-29" } }), CONTEXT);

    expect(item.facts).toMatchObject({ startsIn: "today", days: 1 });
  });

  it("uses an all-day event's own time zone when it has one", () => {
    const item = calendarItem(invite({ start: { date: "2026-10-01", timeZone: "America/New_York" }, end: { date: "2026-10-02" } }), CONTEXT);

    expect(item.start).toEqual(new Date("2026-10-01T04:00:00Z"));
  });

  it("formats the start in UTC when the calendar's time zone is unknown", () => {
    const item = calendarItem(invite(), { ...CONTEXT, timeZone: "Not/AZone" });

    expect(item.facts?.starts).toMatch(/^Wed,? 30 Sept? 2026,? 12:00 \(UTC\)$/);
  });

  it.each<[number, string]>([
    [-5, "already started"],
    [0, "already started"],
    [1, "1 minute"],
    [25, "25 minutes"],
    [89, "89 minutes"],
    [90, "2 hours"],
    [60, "60 minutes"],
    [180, "3 hours"],
    [35 * 60, "35 hours"],
    [36 * 60, "2 days"],
    [24 * 60 * 9, "9 days"],
  ])("says an event %i minutes away starts in %s", (minutes, expected) => {
    expect(calendarItem(invite(startingIn(minutes)), CONTEXT).facts?.startsIn).toBe(expected);
  });

  it("takes the times of a recurring event from its next occurrence", () => {
    const series = invite({
      id: "weekly",
      recurrence: ["RRULE:FREQ=WEEKLY"],
      start: { dateTime: "2026-09-01T09:00:00+02:00" },
      end: { dateTime: "2026-09-01T09:30:00+02:00" },
    });
    const occurrence: CalendarEvent = {
      ...series,
      id: "weekly_20260929T070000Z",
      recurrence: undefined,
      recurringEventId: "weekly",
      start: { dateTime: "2026-09-29T09:00:00+02:00" },
      end: { dateTime: "2026-09-29T09:30:00+02:00" },
    };

    const item = calendarItem(series, { ...CONTEXT, occurrence });

    expect(item).toMatchObject({ eventId: "weekly", recurring: true, start: new Date("2026-09-29T07:00:00Z"), end: new Date("2026-09-29T07:30:00Z") });
    expect(item.facts).toMatchObject({ recurring: true, durationMinutes: 30, startsIn: "23 hours" });
  });

  it("answers one occurrence's invite through its series", () => {
    const occurrence = invite({ id: "weekly_20260929T070000Z", recurringEventId: "weekly" });

    const item = calendarItem(occurrence, { ...CONTEXT, change: "existing", eventId: "weekly" });

    expect(item).toMatchObject({ eventId: "weekly", recurring: true, change: "existing" });
    expect(item.facts?.change).toBe("existing");
  });

  it("knows when you're the organizer, by flag or by address", () => {
    const flagged = calendarItem(invite({ organizer: { email: "Me@Acme.com", self: true } }), { ...CONTEXT, organizer: { ...stranger, you: true } });
    const byAddress = calendarItem(invite({ organizer: { email: "ME@acme.com" } }), CONTEXT);

    for (const item of [flagged, byAddress]) {
      expect(item.organizer).toEqual({ email: "me@acme.com", you: true });
      expect(item.facts?.organizer).toBe("you");
      expect(item.facts).not.toHaveProperty("organizerIsColleague");
    }
  });

  it("falls back to the creator, then to 'unknown', when there's no organizer", () => {
    const created = calendarItem(invite({ organizer: undefined, creator: { email: "bob@example.com", displayName: "Bob" } }), CONTEXT);
    expect(created.author).toEqual({ id: "bob@example.com", name: "Bob", email: "bob@example.com" });
    expect(created.facts?.organizer).toBe("Bob <bob@example.com>");

    const nobody = calendarItem(invite({ organizer: undefined }), CONTEXT);
    expect(nobody.author).toEqual({ id: "unknown", name: "unknown", email: "unknown" });
    expect(nobody.facts?.organizer).toBe("unknown");
  });

  it("maps every answer to an invite", () => {
    const item = calendarItem(
      invite({
        attendees: [
          { email: "a@example.com", responseStatus: "accepted" },
          { email: "b@example.com", responseStatus: "declined" },
          { email: "c@example.com", responseStatus: "tentative" },
          { email: "d@example.com", responseStatus: "needsAction" },
          { email: "e@example.com" },
        ],
      }),
      CONTEXT,
    );

    expect(item.attendees.map((a) => a.response)).toEqual(["accepted", "declined", "maybe", "pending", "pending"]);
    expect(item).not.toHaveProperty("yourResponse");
    expect(item.facts).not.toHaveProperty("yourResponse");
  });

  it("finds you on the guest list by address too", () => {
    const item = calendarItem(invite({ attendees: [{ email: "ME@acme.com", responseStatus: "accepted" }] }), CONTEXT);

    expect(item.yourResponse).toBe("accepted");
    expect(item.attendees[0]?.you).toBe(true);
  });

  it("adds the facts it knows about the organizer, and leaves out the ones it doesn't", () => {
    expect(calendarItem(invite(), CONTEXT).facts).not.toHaveProperty("organizerIsColleague");
    const colleague = calendarItem(invite(), { ...CONTEXT, organizer: { ...stranger, colleague: true, emailedBefore: undefined } });
    expect(colleague.facts).toMatchObject({ organizerIsColleague: true });
    expect(colleague.facts).not.toHaveProperty("organizerEmailedBefore");
  });

  it("names an event without a title, and dates it by when it was created, or now", () => {
    const untitled = calendarItem(invite({ summary: "  " }), CONTEXT);
    expect(untitled.title).toBe("(no title)");
    expect(untitled.id).toBe("e1:");
    expect(untitled.at).toEqual(NOW);

    expect(calendarItem(invite({ created: "2026-09-20T09:00:00Z" }), CONTEXT).at).toEqual(new Date("2026-09-20T09:00:00Z"));
  });

  it("keeps a plain-text description plain, and caps a long one", () => {
    expect(calendarItem(invite({ description: "\r\nAgenda:\r\n1. Budget\r\n" }), CONTEXT).description).toBe("Agenda:\n1. Budget");
    expect(calendarItem(invite({ description: "Revenue < 5% and costs > 2%" }), CONTEXT).description).toBe("Revenue < 5% and costs > 2%");
    expect(calendarItem(invite({ description: "x".repeat(3_000) }), CONTEXT).description).toBe(`${"x".repeat(2_000)}…`);
  });

  it.each<[string, Partial<CalendarEvent>, string | undefined]>([
    ["Google Meet", { hangoutLink: "https://meet.google.com/abc-defg-hij" }, "https://meet.google.com/abc-defg-hij"],
    [
      "a conference's video entry",
      { conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+46-8-123" }, { entryPointType: "video", uri: "https://acme.zoom.us/j/123" }] } },
      "https://acme.zoom.us/j/123",
    ],
    ["a Zoom link in the location", { location: "https://acme.zoom.us/j/555?pwd=x" }, "https://acme.zoom.us/j/555?pwd=x"],
    [
      "a Teams link in the description",
      { description: '<p>Join: <a href="https://teams.microsoft.com/l/meetup-join/19%3a">Click here</a></p>' },
      "https://teams.microsoft.com/l/meetup-join/19%3a",
    ],
    ["other links", { location: "Room 4", description: "Agenda: https://example.com/agenda" }, undefined],
  ])("finds the video link in %s", (_name, event, expected) => {
    const item = calendarItem(invite(event), CONTEXT);

    expect(item.meetingLink).toBe(expected);
    expect(item.facts?.hasMeetingLink).toBe(expected !== undefined);
  });

  it("carries why the event is protected", () => {
    expect(calendarItem(invite(), { ...CONTEXT, protectedBecause: "colleague at acme.com" }).protectedBecause).toBe("colleague at acme.com");
    expect(calendarItem(invite(), CONTEXT)).not.toHaveProperty("protectedBecause");
  });
});

describe("describeEvent", () => {
  it("shows Jev the title, description, facts and who else is invited", () => {
    const item = calendarItem(
      invite({
        description: "Q3 numbers.",
        attendees: [
          { email: "ann@example.com", displayName: "Ann Smith", organizer: true },
          { email: "me@acme.com", self: true },
          { email: "bob@example.com", displayName: "Bob" },
          { email: "cy@example.com" },
        ],
      }),
      { ...CONTEXT, organizer: stranger },
    );

    expect(describeEvent(item)).toEqual({
      title: "Budget review",
      description: "Q3 numbers.",
      starts: item.facts?.starts,
      startsIn: "2 days",
      durationMinutes: 60,
      change: "new",
      organizer: "Ann Smith <ann@example.com>",
      attendeeCount: 4,
      recurring: false,
      hasMeetingLink: false,
      yourResponse: "pending",
      organizerIsColleague: false,
      organizerEmailedBefore: false,
      attendees: ["you", "Bob <bob@example.com>", "cy@example.com"],
    });
  });

  it("lists ten guests and counts the rest", () => {
    const attendees = Array.from({ length: 13 }, (_, index) => ({ email: `guest${index + 1}@example.com` }));

    const described = describeEvent(calendarItem(invite({ attendees }), CONTEXT));

    expect(described).toMatchObject({
      attendees: [...attendees.slice(0, 10).map((a) => a.email), "and 3 more"],
    });
  });

  it("leaves out an empty description and guest list", () => {
    const described = describeEvent(calendarItem(invite({ attendees: undefined }), CONTEXT));

    expect(described).not.toHaveProperty("description");
    expect(described).not.toHaveProperty("attendees");
  });
});

describe("atMidnight", () => {
  it.each<[string, string, string]>([
    ["2026-09-30", "Europe/Stockholm", "2026-09-29T22:00:00.000Z"],
    ["2026-12-30", "Europe/Stockholm", "2026-12-29T23:00:00.000Z"],
    // Clocks go forward at 02:00 that night, and back at 03:00 in October: midnight is before both.
    ["2026-03-29", "Europe/Stockholm", "2026-03-28T23:00:00.000Z"],
    ["2026-10-25", "Europe/Stockholm", "2026-10-24T22:00:00.000Z"],
    ["2026-09-30", "America/Los_Angeles", "2026-09-30T07:00:00.000Z"],
    ["2026-03-08", "America/Los_Angeles", "2026-03-08T08:00:00.000Z"],
    ["2026-09-30", "Asia/Kolkata", "2026-09-29T18:30:00.000Z"],
    // Sydney's clocks go back at 16:00 UTC the day before, so UTC midnight has the wrong offset.
    ["2026-04-05", "Australia/Sydney", "2026-04-04T13:00:00.000Z"],
    ["2026-04-06", "Australia/Sydney", "2026-04-05T14:00:00.000Z"],
    ["2026-09-30", "UTC", "2026-09-30T00:00:00.000Z"],
    ["2026-09-30", "Not/AZone", "2026-09-30T00:00:00.000Z"],
  ])("finds midnight on %s in %s", (date, timeZone, expected) => {
    expect(atMidnight(date, timeZone).toISOString()).toBe(expected);
  });
});
