import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events, GoogleAuthError, withTokens, type CalendarItem, type EventsOptions } from "@jev-events/google";

import { fakeGoogle, type FakeGoogle } from "./fake-google.js";
import { startSource, waitFor, type Started } from "./helpers.js";

let google: FakeGoogle;
let running: Array<Started<CalendarItem>> = [];

beforeEach(async () => {
  google = await fakeGoogle();
});

afterEach(async () => {
  for (const run of running) run.stop();
  running = [];
  await google.close();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

/** Start a Calendar source that checks every 10ms. */
function watch(options: Partial<EventsOptions> = {}) {
  const source = events({ auth: withTokens(google.tokens()), every: 10, ...options });
  const run = startSource(source);
  running.push(run);
  return { source, ...run };
}

/** The change checks (lists with a sync token) on a calendar. */
function checks(calendarId = "primary") {
  return google.calls(`GET /calendars/${encodeURIComponent(calendarId)}/events`).filter((r) => r.query.syncToken !== undefined);
}

/** Wait for `count` more change checks, so every change made before has been seen. */
async function polled(count = 2, calendarId = "primary"): Promise<void> {
  const target = checks(calendarId).length + count;
  await waitFor(() => checks(calendarId).length >= target, 2_000, `${count} more calendar checks`);
}

describe("events", () => {
  it("is a Calendar source that native actions can use", () => {
    const source = events({ auth: withTokens(google.tokens()) });

    expect(source).toMatchObject({ id: "google-calendar:primary", platform: "google-calendar", noun: "event", canAct: true });
    expect(source.session).toBeUndefined();
  });

  it("emits events as they're added, once each", async () => {
    const { source, items, started } = watch();
    await started;
    // Added before the first check, so one check pages through all three.
    google.addEvent({
      summary: "Budget review",
      organizer: { email: "ann@example.com", displayName: "Ann" },
      attendees: [{ email: "ann@example.com" }, { email: "me@acme.com" }],
    });
    google.addEvent({ summary: "1:1" });
    google.addEvent({ summary: "Offsite", start: { date: inDays(2) } });

    await waitFor(() => items.length === 3);
    await polled();

    expect(items.map((item) => [item.title, item.change, item.allDay])).toEqual([
      ["Budget review", "new", false],
      ["1:1", "new", false],
      ["Offsite", "new", true],
    ]);
    expect(items[0]).toMatchObject({ eventId: "e1", calendarId: "primary", yourResponse: "pending", organizer: { email: "ann@example.com", name: "Ann", you: false } });
    expect(source.session).toMatchObject({ me: "me@acme.com", calendarId: "primary", timeZone: "Europe/Stockholm" });

    const lists = google.calls("GET /calendars/primary/events");
    expect(lists[0]?.query).toEqual({ timeMin: expect.any(String), maxResults: "250" });
    expect(lists[1]?.query).toEqual({ syncToken: "sync-0", maxResults: "250" });
    expect(lists[2]?.query).toEqual({ syncToken: "sync-0", pageToken: "p-2-3", maxResults: "250" });
    expect(lists.at(-1)?.query.syncToken).toBe("sync-3");
  });

  it("doesn't emit events that were there before it started", async () => {
    google.addEvent({ summary: "Old" });
    const { items, started } = watch();
    await started;

    await polled();

    expect(items).toEqual([]);
  });

  it("emits the next events when backfill asks, one per series, then changes", async () => {
    google.addEvent({ summary: "Later", start: { dateTime: inHours(48) } });
    google.addEvent({ summary: "Standup", recurrence: ["RRULE:FREQ=DAILY"], start: { dateTime: inHours(1) } });
    google.addEvent({ summary: "Office", eventType: "workingLocation", start: { dateTime: inHours(2) } });
    google.addEvent({ summary: "Soon", start: { dateTime: inHours(3) } });
    google.addEvent({ summary: "Ann's birthday", eventType: "birthday", start: { date: inDays(1) } });
    const { items, started } = watch({ backfill: 3 });
    await started;
    await waitFor(() => items.length === 3);

    google.addEvent({ summary: "New" });
    await waitFor(() => items.length === 4);

    expect(items.map((item) => [item.title, item.change, item.eventId, item.recurring])).toEqual([
      ["Standup", "existing", "e2", true],
      ["Soon", "existing", "e4", false],
      ["Later", "existing", "e1", false],
      ["New", "new", "e6", false],
    ]);
    const backfill = google.calls("GET /calendars/primary/events").find((r) => r.query.singleEvents);
    expect(backfill?.query).toMatchObject({ singleEvents: "true", orderBy: "startTime", maxResults: "15" });
  });

  it("emits an event again when something Jev reads changes, but not when only answers change", async () => {
    const budget = google.addEvent({ summary: "Budget review", attendees: [{ email: "me@acme.com" }, { email: "bob@example.com" }] });
    const { items, started } = watch();
    await started;
    google.respond(budget.id, "bob@example.com", "accepted");
    await polled();
    expect(items).toEqual([]);

    google.updateEvent(budget.id, { start: { dateTime: inHours(5) }, end: { dateTime: inHours(6) } });
    await waitFor(() => items.length === 1);
    const lunch = google.addEvent({ summary: "Lunch" });
    await waitFor(() => items.length === 2);
    google.updateEvent(lunch.id, { location: "Pizzeria" });
    await waitFor(() => items.length === 3);

    expect(items.map((item) => [item.title, item.change, item.location])).toEqual([
      ["Budget review", "updated", undefined],
      ["Lunch", "new", undefined],
      ["Lunch", "updated", "Pizzeria"],
    ]);
    // Each version has its own ID, so a listener judges it again.
    expect(new Set(items.map((item) => item.id)).size).toBe(3);
  });

  it("follows a recurring series by its next occurrence, and skips one that has ended", async () => {
    const { items, started } = watch();
    await started;
    const standup = google.addEvent({ summary: "Standup", recurrence: ["RRULE:FREQ=DAILY"], start: { dateTime: inHours(-71) } });
    google.addEvent({ summary: "Sprint", recurrence: ["RRULE:FREQ=DAILY;COUNT=2"], start: { dateTime: inHours(-72) } });
    google.addEvent({ summary: "Lunch" });

    await waitFor(() => items.length === 2);
    await polled();

    expect(items.map((item) => item.title)).toEqual(["Standup", "Lunch"]);
    expect(items[0]).toMatchObject({ eventId: standup.id, recurring: true, change: "new" });
    expect(items[0]?.start.getTime()).toBe(Date.parse(standup.start?.dateTime ?? "") + 3 * DAY);
    expect(google.calls(`GET /calendars/primary/events/${standup.id}/instances`)[0]?.query).toMatchObject({ maxResults: "1" });
  });

  it("skips past events, cancelled events, working locations and birthdays", async () => {
    const { items, errors, started } = watch();
    await started;
    google.addEvent({ summary: "Yesterday", start: { dateTime: inHours(-24) } });
    google.cancelEvent(google.addEvent({ summary: "Cancelled" }).id);
    google.addEvent({ summary: "Office", eventType: "workingLocation" });
    google.addEvent({ summary: "Ann's birthday", eventType: "birthday", start: { date: inDays(1) } });
    google.addEvent({ summary: "Kept" });

    // Changes are handled in order, so once "Kept" is out the others were skipped.
    await waitFor(() => items.length === 1);
    await polled();

    expect(items.map((item) => item.title)).toEqual(["Kept"]);
    expect(errors).toEqual([]);
  });

  it("forgets a cancelled event, so one that comes back is new again", async () => {
    const offsite = google.addEvent({ summary: "Offsite" });
    const { items, started } = watch();
    await started;
    google.cancelEvent(offsite.id);
    await polled();

    google.updateEvent(offsite.id, { status: "confirmed" });
    await waitFor(() => items.length === 1);

    expect(items[0]).toMatchObject({ title: "Offsite", change: "new" });
  });

  it("watches another calendar, in its time zone", async () => {
    const team = "team@group.calendar.google.com";
    google.addCalendar(team, "America/New_York");
    const { source, items, started } = watch({ calendarId: team });
    await started;
    google.addEvent({ summary: "Team sync" }, team);
    google.addEvent({ summary: "Mine" });

    await waitFor(() => items.length === 1);
    await polled(2, team);

    expect(source.id).toBe(`google-calendar:${team}`);
    expect(source.session).toMatchObject({ calendarId: team, timeZone: "America/New_York" });
    expect(items.map((item) => [item.title, item.calendarId])).toEqual([["Team sync", team]]);
    expect(google.calls("GET /calendars/team%40group.calendar.google.com")).toHaveLength(1);
  });

  it("starts over from now when Google asks for a full resync", async () => {
    const { items, warnings, started } = watch();
    await started;
    await polled(1);
    // Added while the source is paused, and then Google expires the sync token.
    google.addEvent({ summary: "Missed" });
    google.expireSync();

    await waitFor(() => {
      const lists = google.calls("GET /calendars/primary/events");
      const rebaseline = lists.findLastIndex((r) => r.query.syncToken === undefined);
      return rebaseline > 0 && lists.slice(rebaseline + 1).some((r) => r.query.syncToken !== undefined);
    });
    google.addEvent({ summary: "After" });
    await waitFor(() => items.length === 1);

    expect(warnings).toEqual(["Google Calendar asked for a full resync, so changes made in the last moments may be skipped."]);
    expect(items.map((item) => item.title)).toEqual(["After"]);
  });

  it("reports an outage and keeps checking", async () => {
    const { items, errors, started } = watch();
    await started;
    // The first try and three retries.
    google.fail("GET /calendars/primary/events", 503, { times: 4 });

    await waitFor(() => errors.length === 1);
    google.addEvent({ summary: "After the outage" });
    await waitFor(() => items.length === 1);

    expect(errors[0]?.fatal).toBe(false);
    expect((errors[0]?.error as Error).message).toBe("Google GET /calendars/primary/events failed (503): Backend Error");
  });

  it("reports a series it couldn't look into and goes on with the next event", async () => {
    const { items, errors, started } = watch();
    await started;
    google.fail("GET /calendars/primary/events/e1/instances", 500, { times: 4 });
    google.addEvent({ summary: "Standup", recurrence: ["RRULE:FREQ=DAILY"] });
    google.addEvent({ summary: "Lunch" });

    await waitFor(() => items.length === 1);

    expect(items[0]?.title).toBe("Lunch");
    expect(errors.map((e) => [e.fatal, (e.error as Error).message])).toEqual([
      [false, "Google GET /calendars/primary/events/e1/instances failed (500): Backend Error"],
    ]);
  });

  it("skips a series deleted before it was looked into, without reporting an error", async () => {
    const { items, errors, started } = watch();
    await started;
    google.fail("GET /calendars/primary/events/e1/instances", 404);
    google.addEvent({ summary: "Standup", recurrence: ["RRULE:FREQ=DAILY"] });
    google.addEvent({ summary: "Lunch" });

    await waitFor(() => items.length === 1);

    expect(items[0]?.title).toBe("Lunch");
    expect(errors).toEqual([]);
  });

  it("stops when Google signs you out", async () => {
    const { errors, signal, started } = watch();
    await started;
    google.expireAccessTokens();
    google.revoke();

    await waitFor(() => errors.length > 0);
    await sleep(20);
    const count = google.requests.length;
    await sleep(50);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.fatal).toBe(true);
    expect(errors[0]?.error).toBeInstanceOf(GoogleAuthError);
    expect(signal.aborted).toBe(true);
    expect(google.requests.length).toBe(count);
  });

  it("fails to start without Calendar access", async () => {
    google.fail("GET /calendars/primary", 403);

    const { started } = watch();

    await expect(started).rejects.toThrow("Request had insufficient authentication scopes. Sign in again and tick every box on Google's consent screen");
  });

  it("fails to start when Google gives no way to follow changes", async () => {
    google.fail("GET /calendars/primary/events", 200, { body: { items: [] } });

    const { started } = watch();

    await expect(started).rejects.toThrow("Google Calendar didn't return a sync token, so changes can't be followed.");
  });

  it("stops checking when stopped", async () => {
    const { stop, started } = watch();
    await started;
    await polled();

    stop();
    await sleep(20);
    const count = google.requests.length;
    await sleep(50);

    expect(google.requests.length).toBe(count);
  });
});

describe("protection", () => {
  const invite = (summary: string, organizer: string) =>
    google.addEvent({ summary, organizer: { email: organizer }, attendees: [{ email: organizer }, { email: "me@acme.com" }] });

  it("protects your own events, colleagues' and people you've emailed, and says why", async () => {
    google.emailed("friend@example.com");
    const { source, items, started } = watch();
    await started;
    google.addEvent({ summary: "Mine" });
    invite("Colleague", "ann@acme.com");
    invite("Friend", "Friend@example.com");
    invite("Stranger", "sales@vendor.example");

    await waitFor(() => items.length === 4);

    expect(items.map((item) => [item.title, source.isProtected?.(item)])).toEqual([
      ["Mine", "you organized it"],
      ["Colleague", "colleague at acme.com"],
      ["Friend", "you've emailed friend@example.com before"],
      ["Stranger", false],
    ]);
    expect(items[0]?.facts).not.toHaveProperty("organizerIsColleague");
    expect(items[3]?.facts).toMatchObject({ organizerIsColleague: false, organizerEmailedBefore: false });
  });

  it("protects whoever the protect option says", async () => {
    const off = watch({ protect: false });
    const custom = watch({ protect: { addresses: ["vendor.example"], except: ["ann@acme.com"] } });
    await Promise.all([off.started, custom.started]);
    invite("Colleague", "ann@acme.com");
    invite("Vendor", "sales@vendor.example");

    await waitFor(() => off.items.length === 2 && custom.items.length === 2);

    expect(off.items.map((item) => item.protectedBecause)).toEqual([undefined, undefined]);
    expect(custom.items.map((item) => item.protectedBecause)).toEqual([undefined, "on your protect list"]);
  });

  it("judges but doesn't act on an event when it can't check your Sent folder", async () => {
    const { items, warnings, started } = watch();
    await started;
    google.fail("GET /messages", 400);
    invite("Demo", "sales@vendor.example");

    await waitFor(() => items.length === 1);

    expect(items[0]?.protectedBecause).toBe("couldn't check your Sent folder");
    expect(warnings).toEqual(["Couldn't check whether you've emailed sales@vendor.example before: Google GET /messages failed (400): Bad Request"]);
  });

  it("protects colleagues only when you signed in without Gmail", async () => {
    const { items, warnings, started } = watch();
    await started;
    google.fail("GET /messages", 403);
    invite("Demo", "sales@vendor.example");
    invite("Colleague", "ann@acme.com");

    await waitFor(() => items.length === 2);

    expect(items.map((item) => item.protectedBecause)).toEqual([undefined, "colleague at acme.com"]);
    expect(items[0]?.facts).not.toHaveProperty("organizerEmailedBefore");
    expect(google.calls("GET /messages")).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});
