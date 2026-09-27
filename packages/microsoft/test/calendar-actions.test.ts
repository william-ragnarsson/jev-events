import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, decline, events, maybe, respond, type Answer } from "@jev-events/microsoft";

import { fakeMicrosoft, type FakeEventInput, type FakeMicrosoft } from "./fake-microsoft.js";
import { checker, connectionTo, firedOn } from "./helpers.js";

let microsoft: FakeMicrosoft;

beforeEach(async () => {
  microsoft = await fakeMicrosoft();
});

afterEach(async () => {
  await microsoft.close();
});

/** A new event that the calendar source just read, ready for an action to run on. */
async function newEvent(event: FakeEventInput) {
  const run = checker(events({ timeZone: "UTC" }), { connection: connectionTo(microsoft) });
  await run.check();
  const id = microsoft.addEvent({ start: Date.now() + 24 * 60 * 60_000, ...event });
  await run.check();
  const [item] = run.items;
  if (!item) throw new Error("The calendar didn't emit the event.");
  return { id, event: firedOn(item), ctx: await run.actionContext() };
}

const invite = { subject: "Planning", organizer: "Ann Lee <ann@example.com>", response: "notResponded" } as const;

describe("Outlook Calendar actions", () => {
  it.each([
    ["accept", accept, "accepted", 'accept "Planning"'],
    ["decline", decline, "declined", 'decline "Planning"'],
    ["maybe", maybe, "tentativelyAccepted", 'answer maybe to "Planning"'],
  ] as const)("%s answers the invite and tells the organizer", async (_name, action, response, description) => {
    const { id, event, ctx } = await newEvent(invite);

    await action().run(event, ctx);

    expect(microsoft.rsvps).toEqual([{ id, response, comment: undefined, sendResponse: true }]);
    expect(action().describe(event)).toBe(description);
  });

  it("sends a note with the answer, and doesn't tell an organizer who asked for no replies", async () => {
    const { id, event, ctx } = await newEvent({ ...invite, responseRequested: false });

    await decline({ comment: "I'm away that week." }).run(event, ctx);

    expect(microsoft.rsvps).toEqual([{ id, response: "declined", comment: "I'm away that week.", sendResponse: false }]);
    expect(decline({ comment: "x" }).describe(event)).toBe('decline "Planning" with a note');
  });

  it("answers for every occurrence of a series", async () => {
    const { event } = await newEvent({ ...invite, subject: "Standup", repeat: { every: "day", count: 3 } });

    expect(accept().describe(event)).toBe('accept "Standup" (every occurrence)');
  });

  it("refuses to answer an event you organized", async () => {
    const { event, ctx } = await newEvent({ subject: "Mine" });

    await expect(accept().run(event, ctx)).rejects.toThrow(`You organized "Mine", so there's no invite to answer.`);
    expect(microsoft.rsvps).toEqual([]);
  });

  it("says what it takes and where its items come from", async () => {
    const { event, ctx } = await newEvent(invite);

    expect(() => respond("yes" as Answer)).toThrow(`respond() takes "accepted", "declined" or "maybe", not "yes".`);
    await expect(accept().run(event, { ...ctx, session: undefined as never })).rejects.toThrow(
      "Calendar actions run on items from microsoft.calendar.events() or microsoft.calendar.invites().",
    );
  });
});
