import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, decline, events, invites, maybe, respond, type Answer, type CalendarItem } from "@jev-events/google";
import { memoryStore, monitor, noul, silentLogger, type ActionEvent, type JudgedEvent } from "jev-events";
import { mockJev } from "jev-events/testing";

import { fakeGoogle, type FakeEvent, type FakeGoogle } from "./fake-google.js";
import { checker, connectionTo, firedOn } from "./helpers.js";

let google: FakeGoogle;

beforeEach(async () => {
  google = await fakeGoogle();
});

afterEach(async () => {
  await google.close();
});

/** Watch a calendar, then have Ann invite you, to run actions on the invite directly. */
async function invited(event: Partial<FakeEvent> = {}, calendarId = "primary") {
  const run = checker(events({ calendarId }), { connection: connectionTo(google) });
  await run.check();
  google.addEvent(
    {
      summary: "Budget review",
      organizer: { email: "ann@example.com", displayName: "Ann" },
      attendees: [
        { email: "ann@example.com", responseStatus: "accepted" },
        { email: "me@acme.com" },
        { email: "bob@example.com", responseStatus: "tentative" },
      ],
      ...event,
    },
    calendarId,
  );
  await run.check();
  const item = run.items.at(-1)!;
  return { item, event: firedOn(item), ctx: await run.actionContext() };
}

/** Each guest's answer on an event in the fake, in guest-list order. */
const answers = (id: string, calendarId = "primary") => google.event(id, calendarId)?.attendees?.map((a) => [a.email, a.responseStatus]);

describe("answering an invite", () => {
  it.each([
    ["accepts", accept, "accepted", 'accept "Budget review"'],
    ["declines", decline, "declined", 'decline "Budget review"'],
    ["answers maybe to", maybe, "tentative", 'answer maybe to "Budget review"'],
  ] as const)("%s an invite, telling the organizer and leaving the other guests as they were", async (_name, action, status, description) => {
    const { event, ctx } = await invited();

    await action().run(event, ctx);

    expect(google.calls("PATCH /calendars/primary/events/e1").map((r) => [r.query, r.body])).toEqual([
      [{ sendUpdates: "all" }, { attendeesOmitted: true, attendees: [{ email: "me@acme.com", responseStatus: status }] }],
    ]);
    expect(answers("e1")).toEqual([
      ["ann@example.com", "accepted"],
      ["me@acme.com", status],
      ["bob@example.com", "tentative"],
    ]);
    expect(action().describe(event)).toBe(description);
  });

  it("names each answer, and respond() takes the answer as a word", async () => {
    const { event, ctx } = await invited();

    await respond("maybe").run(event, ctx);

    expect([accept(), decline(), maybe(), respond("maybe")].map((action) => action.name)).toEqual([
      "calendar.accept",
      "calendar.decline",
      "calendar.maybe",
      "calendar.maybe",
    ]);
    expect(answers("e1")?.[1]).toEqual(["me@acme.com", "tentative"]);
    expect(() => respond("yes" as Answer)).toThrow(`respond() takes "accepted", "declined" or "maybe", not "yes".`);
  });

  it("sends a note with the answer", async () => {
    const { event, ctx } = await invited();

    await decline({ comment: "I'm away that week." }).run(event, ctx);

    expect(google.calls("PATCH /calendars/primary/events/e1")[0]?.body).toEqual({
      attendeesOmitted: true,
      attendees: [{ email: "me@acme.com", responseStatus: "declined", comment: "I'm away that week." }],
    });
    expect(google.event("e1")?.attendees?.find((a) => a.self)?.comment).toBe("I'm away that week.");
    expect(decline({ comment: "x" }).describe(event)).toBe('decline "Budget review" with a note');
  });

  it("answers for the whole series when the event is one of a series", async () => {
    const { event, ctx } = await invited({ summary: "Standup", recurrence: ["RRULE:FREQ=DAILY"] });

    await accept().run(event, ctx);

    expect(google.calls(/^PATCH /).map((r) => r.path)).toEqual(["/calendars/primary/events/e1"]);
    expect(answers("e1")?.[1]).toEqual(["me@acme.com", "accepted"]);
    expect(accept().describe(event)).toBe('accept "Standup" (every occurrence)');
  });

  it("answers on the calendar the event is on", async () => {
    const team = "team@group.calendar.google.com";
    google.addCalendar(team, "Europe/Stockholm");
    const { event, ctx } = await invited({}, team);

    await accept().run(event, ctx);

    expect(google.calls(/^PATCH /).map((r) => r.path)).toEqual(["/calendars/team%40group.calendar.google.com/events/e1"]);
    expect(answers("e1", team)?.[1]).toEqual(["me@acme.com", "accepted"]);
  });

  it("refuses to answer an event you organized", async () => {
    const { event, ctx } = await invited({ organizer: { email: "me@acme.com" }, attendees: [{ email: "me@acme.com" }, { email: "bob@example.com" }] });

    await expect(accept().run(event, ctx)).rejects.toThrow(`You organized "Budget review", so there's no invite to answer.`);
    expect(google.calls(/^PATCH /)).toEqual([]);
  });

  it("refuses to answer an event you're not invited to", async () => {
    const { event, ctx } = await invited({ attendees: [{ email: "ann@example.com" }, { email: "bob@example.com" }] });

    await expect(decline().run(event, ctx)).rejects.toThrow(`You're not on the guest list of "Budget review".`);
    expect(google.calls(/^PATCH /)).toEqual([]);
  });

  it("reports what Google said when the answer fails", async () => {
    const { event, ctx } = await invited();
    google.fail("PATCH /calendars/primary/events/e1", 404);

    await expect(accept().run(event, ctx)).rejects.toThrow("Google PATCH /calendars/primary/events/e1 failed (404): Requested entity was not found.");
  });

  it("runs only on items from the Calendar sources", async () => {
    const { event, ctx } = await invited();

    await expect(accept().run(event, { ...ctx, session: undefined as never })).rejects.toThrow(
      "Calendar actions run on items from google.calendar.events() or google.calendar.invites().",
    );
  });
});

describe("in a monitor", () => {
  const important = noul("Is this meeting important to me?");
  // By title only: an invite can also mention the events it clashes with.
  const jev = () => mockJev(({ state }) => ({ important: /"title":"Board/.test(JSON.stringify(state)) ? 0.95 : 0.05 }));
  const invite = (summary: string, organizer: string) =>
    google.addEvent({ summary, organizer: { email: organizer }, attendees: [{ email: organizer }, { email: "me@acme.com" }] });

  /** One check of your invites, as a cron job would run it. */
  async function check(store: ReturnType<typeof memoryStore>, dryRun?: boolean) {
    const actions: Array<ActionEvent<CalendarItem>> = [];
    const judged: Array<JudgedEvent<CalendarItem>> = [];
    await monitor({ source: invites(), questions: { important }, client: jev(), log: silentLogger, ...(dryRun === undefined ? {} : { dryRun }) })
      .on("important", accept())
      .on("judged", (e) => void judged.push(e))
      .on("action", (e) => void actions.push(e))
      .run({ store, connections: [connectionTo(google)] });
    return { actions, judged };
  }

  it("accepts important invites when armed, never a colleague's, and judges each once", async () => {
    const store = memoryStore();
    await check(store, false);
    invite("Board meeting", "chair@board.example");
    invite("Board prep", "ann@acme.com");
    invite("Lunch and learn", "events@vendor.example");

    const { actions, judged } = await check(store, false);
    // Accepting changed the event on Google's side, but an answer isn't a new invite.
    const after = await check(store, false);

    expect(actions.map((e) => [e.event.item.title, e.status, e.reason]).sort()).toEqual([
      ["Board meeting", "done", undefined],
      ["Board prep", "skipped", "colleague at acme.com"],
    ]);
    expect(answers("e1")?.[1]).toEqual(["me@acme.com", "accepted"]);
    expect(answers("e2")?.[1]).toEqual(["me@acme.com", "needsAction"]);
    expect(judged.map((e) => e.item.title).sort()).toEqual(["Board meeting", "Board prep", "Lunch and learn"]);
    expect(after.judged).toEqual([]);
  });

  it("only says what it would do in dry-run, the default", async () => {
    const store = memoryStore();
    await check(store);
    invite("Board meeting", "chair@board.example");

    const { actions } = await check(store);

    expect(actions.map((e) => [e.status, e.description])).toEqual([["dry-run", 'accept "Board meeting"']]);
    expect(google.calls(/^PATCH /)).toEqual([]);
  });
});
