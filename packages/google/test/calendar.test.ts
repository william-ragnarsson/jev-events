import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events, GoogleAuthError, invites, type CalendarSource, type EventsOptions } from "@jev-events/google";
import { needsSignIn, toConnection } from "jev-events";

import { fakeGoogle, type FakeEvent, type FakeGoogle } from "./fake-google.js";
import { checker, connectionTo } from "./helpers.js";

let google: FakeGoogle;

beforeEach(async () => {
  google = await fakeGoogle();
});

afterEach(async () => {
  await google.close();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const at = (from: number, to: number) => ({ start: { dateTime: inHours(from) }, end: { dateTime: inHours(to) } });

/** A Calendar source on the fake's account. Each `check()` is one scheduled check. */
function watch(options: EventsOptions = {}, source: CalendarSource = events(options)) {
  return Object.assign(checker(source, { connection: connectionTo(google) }), { source });
}

/** A watch that has done its first check, so it emits what changes from now on. */
async function watching(options: EventsOptions = {}, source?: CalendarSource) {
  const run = watch(options, source);
  await run.check();
  return run;
}

/** Full lists and change checks of a calendar, leaving out the lookups of what an invite clashes with. */
function lists(calendarId = "primary") {
  return google.calls(`GET /calendars/${encodeURIComponent(calendarId)}/events`).filter((r) => r.query.timeMax === undefined);
}

/** An invite from `organizer` to you, not answered yet. */
const invite = (summary: string, organizer: string, extra: Partial<FakeEvent> = {}) =>
  google.addEvent({ summary, organizer: { email: organizer }, attendees: [{ email: organizer }, { email: "me@acme.com" }], ...extra });

describe("events", () => {
  it("is a Calendar source for connected Google accounts that native actions can use", () => {
    expect(events()).toMatchObject({
      id: "google-calendar:primary",
      platform: "google-calendar",
      noun: "event",
      canAct: true,
      integration: "google",
      defaults: { every: "30s" },
    });
  });

  it("takes the address saved at sign-in, or asks Gmail for it", async () => {
    expect(await watch().session()).toMatchObject({ me: "me@acme.com", calendarId: "primary" });
    expect(google.requests).toEqual([]);

    const { credentials } = google.connection();
    const unnamed = checker(events(), { connection: toConnection("google", { account: "google", credentials }) });
    expect((await unnamed.session()).me).toBe("me@acme.com");
    expect(google.calls("GET /profile")).toHaveLength(1);
  });

  it("emits events as they're added, once each, with times in the calendar's time zone", async () => {
    const run = await watching();
    google.addEvent({
      summary: "Budget review",
      organizer: { email: "ann@example.com", displayName: "Ann" },
      attendees: [{ email: "ann@example.com" }, { email: "me@acme.com" }],
    });
    google.addEvent({ summary: "1:1" });
    google.addEvent({ summary: "Offsite", start: { date: inDays(2) } });

    await run.check();
    await run.check();

    expect(run.items.map((item) => [item.title, item.change, item.allDay])).toEqual([
      ["Budget review", "new", false],
      ["1:1", "new", false],
      ["Offsite", "new", true],
    ]);
    expect(run.items[0]).toMatchObject({ eventId: "e1", calendarId: "primary", yourResponse: "pending", organizer: { email: "ann@example.com", name: "Ann", you: false } });
    expect(run.items[0]?.facts?.starts).toMatch(/\(Europe\/Stockholm\)$/);

    const checks = lists();
    expect(checks[0]?.query).toEqual({ timeMin: expect.any(String), maxResults: "250" });
    expect(checks[1]?.query).toEqual({ syncToken: "sync-0", maxResults: "250" });
    expect(checks[2]?.query).toEqual({ syncToken: "sync-0", pageToken: "p-2-3", maxResults: "250" });
    expect(checks.at(-1)?.query.syncToken).toBe("sync-3");
  });

  it("doesn't emit events that were there before the first check", async () => {
    google.addEvent({ summary: "Old" });
    const run = watch();

    await run.check();
    await run.check();

    expect(run.items).toEqual([]);
    expect(run.cursor).toMatchObject({ syncToken: "sync-1", known: { e1: expect.any(String) } });
  });

  it("emits the next events when backfill asks, one per series, then changes", async () => {
    google.addEvent({ summary: "Later", start: { dateTime: inHours(48) } });
    google.addEvent({ summary: "Standup", recurrence: ["RRULE:FREQ=DAILY"], start: { dateTime: inHours(1) } });
    google.addEvent({ summary: "Office", eventType: "workingLocation", start: { dateTime: inHours(2) } });
    google.addEvent({ summary: "Soon", start: { dateTime: inHours(3) } });
    google.addEvent({ summary: "Ann's birthday", eventType: "birthday", start: { date: inDays(1) } });
    const run = watch({ backfill: 3 });

    await run.check();
    google.addEvent({ summary: "New" });
    await run.check();

    expect(run.items.map((item) => [item.title, item.change, item.eventId, item.recurring])).toEqual([
      ["Standup", "existing", "e2", true],
      ["Soon", "existing", "e4", false],
      ["Later", "existing", "e1", false],
      ["New", "new", "e6", false],
    ]);
    const backfill = lists().find((r) => r.query.singleEvents);
    expect(backfill?.query).toMatchObject({ singleEvents: "true", orderBy: "startTime", maxResults: "15" });
  });

  it("emits an event again when something Jev reads changes, but not when only answers change", async () => {
    const budget = google.addEvent({ summary: "Budget review", attendees: [{ email: "me@acme.com" }, { email: "bob@example.com" }] });
    const run = await watching();

    google.respond(budget.id, "bob@example.com", "accepted");
    await run.check();
    expect(run.items).toEqual([]);

    google.updateEvent(budget.id, at(5, 6));
    await run.check();
    const lunch = google.addEvent({ summary: "Lunch" });
    await run.check();
    google.updateEvent(lunch.id, { location: "Pizzeria" });
    await run.check();

    expect(run.items.map((item) => [item.title, item.change, item.location])).toEqual([
      ["Budget review", "updated", undefined],
      ["Lunch", "new", undefined],
      ["Lunch", "updated", "Pizzeria"],
    ]);
    // Each version has its own ID, so a monitor judges it again.
    expect(new Set(run.items.map((item) => item.id)).size).toBe(3);
  });

  it("follows a recurring series by its next occurrence, and skips one that has ended", async () => {
    const run = await watching();
    const standup = google.addEvent({ summary: "Standup", recurrence: ["RRULE:FREQ=DAILY"], start: { dateTime: inHours(-71) } });
    google.addEvent({ summary: "Sprint", recurrence: ["RRULE:FREQ=DAILY;COUNT=2"], start: { dateTime: inHours(-72) } });
    google.addEvent({ summary: "Lunch" });

    await run.check();

    expect(run.items.map((item) => item.title)).toEqual(["Standup", "Lunch"]);
    expect(run.items[0]).toMatchObject({ eventId: standup.id, recurring: true, change: "new" });
    expect(run.items[0]?.start.getTime()).toBe(Date.parse(standup.start?.dateTime ?? "") + 3 * DAY);
    expect(google.calls(`GET /calendars/primary/events/${standup.id}/instances`)[0]?.query).toMatchObject({ maxResults: "1" });
  });

  it("skips past events, cancelled events, working locations and birthdays", async () => {
    const run = await watching();
    google.addEvent({ summary: "Yesterday", start: { dateTime: inHours(-24) } });
    google.cancelEvent(google.addEvent({ summary: "Cancelled" }).id);
    google.addEvent({ summary: "Office", eventType: "workingLocation" });
    google.addEvent({ summary: "Ann's birthday", eventType: "birthday", start: { date: inDays(1) } });
    google.addEvent({ summary: "Kept" });

    await run.check();

    expect(run.items.map((item) => item.title)).toEqual(["Kept"]);
    expect(run.errors).toEqual([]);
  });

  it("forgets a cancelled event, so one that comes back is new again", async () => {
    const offsite = google.addEvent({ summary: "Offsite" });
    const run = await watching();

    google.cancelEvent(offsite.id);
    await run.check();
    google.updateEvent(offsite.id, { status: "confirmed" });
    await run.check();

    expect(run.items.map((item) => [item.title, item.change])).toEqual([["Offsite", "new"]]);
  });

  it("watches another calendar, in its time zone", async () => {
    const team = "team@group.calendar.google.com";
    google.addCalendar(team, "America/New_York");
    const run = await watching({ calendarId: team });
    google.addEvent({ summary: "Team sync" }, team);
    google.addEvent({ summary: "Mine" });

    await run.check();

    expect(run.source.id).toBe(`google-calendar:${team}`);
    expect((await run.session()).calendarId).toBe(team);
    expect(run.items.map((item) => [item.title, item.calendarId])).toEqual([["Team sync", team]]);
    expect(run.items[0]?.facts?.starts).toMatch(/\(America\/New_York\)$/);
    expect(lists()).toEqual([]);
  });

  it("starts over from now when Google asks for a full resync", async () => {
    const run = await watching();
    // Added while monitoring is paused, and then Google expires the sync token.
    google.addEvent({ summary: "Missed" });
    google.expireSync();

    await run.check();
    google.addEvent({ summary: "After" });
    await run.check();

    expect(run.warnings).toEqual(["Google Calendar asked for a full resync, so changes made in the last moments may be skipped."]);
    expect(run.items.map((item) => item.title)).toEqual(["After"]);
  });

  it("throws an outage, so the next check picks up where this one would have", async () => {
    const run = await watching();
    google.addEvent({ summary: "During the outage" });
    // The first try and three retries.
    google.fail("GET /calendars/primary/events", 503, { times: 4 });

    const error = await run.check().catch((error: unknown) => error);
    await run.check();

    expect((error as Error).message).toBe("Google GET /calendars/primary/events failed (503): Backend Error");
    expect(needsSignIn(error)).toBe(false);
    expect(run.items.map((item) => item.title)).toEqual(["During the outage"]);
  });

  it("reports a series it couldn't look into and goes on with the next event", async () => {
    const run = await watching();
    google.fail("GET /calendars/primary/events/e1/instances", 500, { times: 4 });
    google.addEvent({ summary: "Standup", recurrence: ["RRULE:FREQ=DAILY"] });
    google.addEvent({ summary: "Lunch" });

    await run.check();

    expect(run.items.map((item) => item.title)).toEqual(["Lunch"]);
    expect(run.errors.map((e) => [e.fatal, (e.error as Error).message])).toEqual([
      [false, "Google GET /calendars/primary/events/e1/instances failed (500): Backend Error"],
    ]);
  });

  it("skips a series deleted before it was looked into, without reporting an error", async () => {
    const run = await watching();
    google.fail("GET /calendars/primary/events/e1/instances", 404);
    google.addEvent({ summary: "Standup", recurrence: ["RRULE:FREQ=DAILY"] });
    google.addEvent({ summary: "Lunch" });

    await run.check();

    expect(run.items.map((item) => item.title)).toEqual(["Lunch"]);
    expect(run.errors).toEqual([]);
  });

  it("asks for a new sign-in when Google signed the account out", async () => {
    const run = await watching();
    google.expireAccessTokens();
    google.revoke();

    const error = await run.check().catch((error: unknown) => error);

    expect(error).toBeInstanceOf(GoogleAuthError);
    expect(needsSignIn(error)).toBe(true);
  });

  it("asks for a new sign-in when the account didn't allow Calendar", async () => {
    google.fail("GET /calendars/primary/events", 403);

    const error = await watch().check().catch((error: unknown) => error);

    expect((error as Error).message).toContain("Request had insufficient authentication scopes. Sign in again and tick every box on Google's consent screen.");
    expect(needsSignIn(error)).toBe(true);
  });

  it("says so when Google gives no way to follow changes", async () => {
    google.fail("GET /calendars/primary/events", 200, { body: { items: [] } });

    await expect(watch().check()).rejects.toThrow("Google Calendar didn't return a sync token, so changes can't be followed.");
  });

  it("stops emitting when stopped, and leaves the cursor for the next run", async () => {
    const run = await watching();
    const before = run.cursor;
    google.addEvent({ summary: "Lunch" });

    run.abort();
    await run.check();

    expect(run.items).toEqual([]);
    expect(run.cursor).toEqual(before);
  });
});

describe("invites", () => {
  const watchInvites = (options: EventsOptions = {}) => watching(options, invites(options));

  it("is its own source, so it keeps its own cursor", () => {
    expect(invites()).toMatchObject({ id: "google-calendar:primary:invites", platform: "google-calendar", canAct: true, integration: "google" });
    expect(invites({ calendarId: "team" }).id).toBe("google-calendar:team:invites");
  });

  it("emits only invites waiting for your answer", async () => {
    const run = await watchInvites();
    google.addEvent({ summary: "Mine" });
    invite("Pitch", "sales@vendor.example");
    invite("Accepted", "ann@example.com", { attendees: [{ email: "ann@example.com" }, { email: "me@acme.com", responseStatus: "accepted" }] });
    google.addEvent({ summary: "Not invited", organizer: { email: "ann@example.com" }, attendees: [{ email: "ann@example.com" }] });

    await run.check();

    expect(run.items.map((item) => [item.title, item.yourResponse])).toEqual([["Pitch", "pending"]]);
  });

  it("emits an invite again when it changes before you answer, and not after", async () => {
    const run = await watchInvites();
    const pitch = invite("Pitch", "sales@vendor.example");
    await run.check();

    google.updateEvent(pitch.id, at(5, 6));
    await run.check();
    google.respond(pitch.id, "me@acme.com", "accepted");
    await run.check();
    google.updateEvent(pitch.id, at(7, 8));
    await run.check();

    expect(run.items.map((item) => [item.title, item.change])).toEqual([
      ["Pitch", "new"],
      ["Pitch", "updated"],
    ]);
  });

  it("backfills only invites waiting for your answer", async () => {
    google.addEvent({ summary: "Mine", ...at(1, 2) });
    invite("Pitch", "sales@vendor.example", at(3, 4));
    invite("Accepted", "ann@example.com", { ...at(5, 6), attendees: [{ email: "ann@example.com" }, { email: "me@acme.com", responseStatus: "accepted" }] });
    const run = watch({ backfill: 5 }, invites({ backfill: 5 }));

    await run.check();

    expect(run.items.map((item) => [item.title, item.change])).toEqual([["Pitch", "existing"]]);
  });

  it("says which of your events an invite clashes with", async () => {
    const run = await watchInvites();
    google.addEvent({ summary: "Design review", ...at(3, 4) });
    invite("Board prep", "ann@example.com", { ...at(3, 4), attendees: [{ email: "ann@example.com" }, { email: "me@acme.com", responseStatus: "tentative" }] });
    invite("Declined", "bob@example.com", { ...at(3, 4), attendees: [{ email: "bob@example.com" }, { email: "me@acme.com", responseStatus: "declined" }] });
    google.addEvent({ summary: "Focus time", transparency: "transparent", ...at(3, 4) });
    google.addEvent({ summary: "Offsite", start: { date: inDays(0) }, end: { date: inDays(1) } });
    google.addEvent({ summary: "Later", ...at(5, 6) });
    invite("Pitch", "sales@vendor.example", at(3.5, 4.5));

    await run.check();

    const pitch = run.items.find((item) => item.title === "Pitch");
    expect(pitch?.clashesWith).toEqual(["Design review", "Board prep"]);
    expect(pitch?.facts?.clashesWith).toEqual(["Design review", "Board prep"]);
    // The fake sends two events a page, so the clashes are on the second page.
    expect(google.calls("GET /calendars/primary/events").find((r) => r.query.timeMax)?.query).toEqual({
      timeMin: pitch?.start.toISOString(),
      timeMax: pitch?.end.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "10",
    });
  });

  it("doesn't count other occurrences of the same series as clashes", async () => {
    const run = await watchInvites();
    invite("Weekly sync", "ann@example.com", { recurrence: ["RRULE:FREQ=WEEKLY"], ...at(3, 4) });

    await run.check();

    expect(run.items).toHaveLength(1);
    expect(run.items[0]?.clashesWith).toBeUndefined();
  });

  it("still emits an invite when it can't check what it clashes with", async () => {
    const run = await watchInvites();
    // Looking up the organizer happens between the change check and the clash check.
    google.fail("GET /messages", 400, { run: () => google.fail("GET /calendars/primary/events", 500, { times: 4 }) });
    invite("Pitch", "sales@vendor.example");

    await run.check();

    expect(run.items.map((item) => [item.title, item.clashesWith])).toEqual([["Pitch", undefined]]);
    expect(run.warnings).toContain(`Couldn't check what "Pitch" clashes with: Google GET /calendars/primary/events failed (500): Backend Error`);
  });
});

describe("protection", () => {
  it("protects your own events, colleagues' and people you've emailed, and says why", async () => {
    google.emailed("friend@example.com");
    const run = await watching();
    google.addEvent({ summary: "Mine" });
    invite("Colleague", "ann@acme.com");
    invite("Friend", "Friend@example.com");
    invite("Stranger", "sales@vendor.example");

    await run.check();
    const ctx = { connection: undefined, session: await run.session() };

    expect(run.items.map((item) => [item.title, run.source.isProtected?.(item, ctx)])).toEqual([
      ["Mine", "you organized it"],
      ["Colleague", "colleague at acme.com"],
      ["Friend", "you've emailed friend@example.com before"],
      ["Stranger", false],
    ]);
    expect(run.items[0]?.facts).not.toHaveProperty("organizerIsColleague");
    expect(run.items[3]?.facts).toMatchObject({ organizerIsColleague: false, organizerEmailedBefore: false });
  });

  it("protects whoever the protect option says", async () => {
    const off = await watching({ protect: false });
    const custom = await watching({ protect: { addresses: ["vendor.example"], except: ["ann@acme.com"] } });
    invite("Colleague", "ann@acme.com");
    invite("Vendor", "sales@vendor.example");

    await off.check();
    await custom.check();

    expect(off.items.map((item) => item.protectedBecause)).toEqual([undefined, undefined]);
    expect(custom.items.map((item) => item.protectedBecause)).toEqual([undefined, "on your protect list"]);
  });

  it("judges but doesn't act on an event when it can't check your Sent folder", async () => {
    const run = await watching();
    google.fail("GET /messages", 400);
    invite("Demo", "sales@vendor.example");

    await run.check();

    expect(run.items[0]?.protectedBecause).toBe("couldn't check your Sent folder");
    expect(run.warnings).toEqual(["Couldn't check whether you've emailed sales@vendor.example before: Google GET /messages failed (400): Bad Request"]);
  });

  it("protects colleagues only when you signed in without Gmail", async () => {
    const run = await watching();
    google.fail("GET /messages", 403);
    invite("Demo", "sales@vendor.example");
    invite("Colleague", "ann@acme.com");

    await run.check();

    expect(run.items.map((item) => item.protectedBecause)).toEqual([undefined, "colleague at acme.com"]);
    expect(run.items[0]?.facts).not.toHaveProperty("organizerEmailedBefore");
    expect(google.calls("GET /messages")).toHaveLength(1);
    expect(run.warnings).toEqual([]);
  });
});
