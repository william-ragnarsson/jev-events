import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events, invites, type EventsOptions } from "@jev-events/microsoft";

import { fakeMicrosoft, type FakeMicrosoft } from "./fake-microsoft.js";
import { checker, connectionTo } from "./helpers.js";

let microsoft: FakeMicrosoft;

beforeEach(async () => {
  microsoft = await fakeMicrosoft();
});

afterEach(async () => {
  await microsoft.close();
});

const HOUR = 60 * 60_000;
const tomorrow = () => Math.ceil(Date.now() / HOUR) * HOUR + 24 * HOUR;
const watch = (options: EventsOptions = {}) => checker(events({ timeZone: "UTC", ...options }), { connection: connectionTo(microsoft) });
const titles = (items: Array<{ title: string }>) => items.map((item) => item.title);

describe("calendar.events()", () => {
  it("backfills upcoming events as existing, then emits new ones", async () => {
    microsoft.addEvent({ subject: "Review", start: tomorrow(), location: "Room 1" });
    const calendar = watch({ backfill: 5 });

    await calendar.check();
    microsoft.addEvent({ subject: "Planning", start: tomorrow() + HOUR, organizer: "Ann Lee <ann@example.com>", response: "notResponded" });
    await calendar.check();

    expect(calendar.items.map((item) => [item.title, item.change])).toEqual([
      ["Review", "existing"],
      ["Planning", "new"],
    ]);
    expect(calendar.items[1]).toMatchObject({
      organizer: { email: "ann@example.com", name: "Ann Lee", you: false },
      yourResponse: "pending",
      allDay: false,
      recurring: false,
    });
    expect(calendar.errors).toEqual([]);
  });

  it("emits an event again when it changes, but not when someone answers it", async () => {
    const review = microsoft.addEvent({ subject: "Review", start: tomorrow(), attendees: ["ann@example.com"] });
    const calendar = watch();
    await calendar.check();

    microsoft.updateEvent(review, { location: "Room 2" });
    await calendar.check();
    microsoft.respond(review, "ann@example.com", "accepted");
    await calendar.check();
    await calendar.check();

    expect(calendar.items.map((item) => [item.title, item.change, item.location])).toEqual([["Review", "updated", "Room 2"]]);
  });

  it("forgets cancelled and deleted events", async () => {
    const cancelled = microsoft.addEvent({ subject: "Cancelled", start: tomorrow() });
    const deleted = microsoft.addEvent({ subject: "Deleted", start: tomorrow() });
    const calendar = watch();
    await calendar.check();

    microsoft.cancelEvent(cancelled);
    microsoft.deleteEvent(deleted);
    await calendar.check();

    expect(calendar.items).toEqual([]);
    expect(calendar.errors).toEqual([]);
  });

  it("emits a new series once, reading it once, and a changed occurrence on its own", async () => {
    const calendar = watch();
    await calendar.check();
    const standup = microsoft.addEvent({ subject: "Standup", start: tomorrow(), repeat: { every: "day", count: 3 } });

    await calendar.check();
    expect(microsoft.calls(`GET /me/events/${standup}`)).toHaveLength(1);
    microsoft.changeOccurrence(standup, 1, { location: "Room 9" });
    await calendar.check();

    expect(calendar.items.map((item) => [item.change, item.recurring, item.location ?? null])).toEqual([
      ["new", true, null],
      ["updated", true, "Room 9"],
    ]);
  });

  it("reads the calendar again when Microsoft drops the sync, without emitting it all again", async () => {
    microsoft.addEvent({ subject: "Review", start: tomorrow() });
    const calendar = watch();
    await calendar.check();

    microsoft.expireSync();
    await calendar.check();
    microsoft.addEvent({ subject: "After", start: tomorrow() });
    await calendar.check();

    expect(titles(calendar.items)).toEqual(["After"]);
    expect(calendar.warnings).toContain("Outlook asked for the calendar to be read again from scratch; changes are found by comparing.");
  });

  it("marks all-day events, and protects the ones you organized", async () => {
    const calendar = watch();
    await calendar.check();
    microsoft.addEvent({ subject: "Offsite", start: tomorrow(), isAllDay: true });
    microsoft.addEvent({ subject: "Pitch", start: tomorrow(), organizer: "eve@example.org", response: "notResponded" });

    await calendar.check();

    const [offsite, pitch] = calendar.items;
    expect(offsite).toMatchObject({ title: "Offsite", allDay: true, organizer: { you: true }, protectedBecause: expect.any(String) });
    expect(pitch?.protectedBecause).toBeUndefined();
  });
});

describe("calendar.invites()", () => {
  it("emits only invites waiting for an answer, with what they clash with", async () => {
    const start = tomorrow();
    microsoft.addEvent({ subject: "Mine", start });
    microsoft.addEvent({ subject: "Focus time", start, showAs: "free" });
    microsoft.addEvent({ subject: "Said yes", start: start + 3 * HOUR, organizer: "bob@example.com", response: "accepted" });
    const calendar = checker(invites({ timeZone: "UTC", backfill: 5 }), { connection: connectionTo(microsoft) });

    await calendar.check();
    microsoft.addEvent({ subject: "Planning", start, organizer: "Ann Lee <ann@example.com>", response: "notResponded" });
    await calendar.check();

    expect(titles(calendar.items)).toEqual(["Planning"]);
    const clashes = JSON.stringify(calendar.items[0]?.clashesWith);
    expect(clashes).toContain("Mine");
    expect(clashes).not.toContain("Focus time");
  });
});
