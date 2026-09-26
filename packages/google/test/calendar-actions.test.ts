import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, calendarItem, decline, events, maybe, withTokens, type CalendarItem, type EventsOptions } from "@jev-events/google";
import { listen, noul, silentLogger, type ActionEvent, type JudgedEvent } from "jev-events";
import { mockJev } from "jev-events/testing";

import { fakeGoogle, type FakeEvent, type FakeGoogle } from "./fake-google.js";
import { firedOn, startSource, waitFor, type Started } from "./helpers.js";

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

/** A started Calendar source that checks every `every`. */
async function started(every: EventsOptions["every"] = "1h") {
  const source = events({ auth: withTokens(google.tokens()), every });
  const run = startSource(source);
  running.push(run);
  await run.started;
  return { source, ...run };
}

/** A started Calendar source and Ann's invite on it, to run actions on directly. */
async function invited(event: Partial<FakeEvent> = {}, calendarId = "primary") {
  const { source } = await started();
  const added = google.addEvent(
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
  const item = calendarItem(added, { calendarId, me: "me@acme.com", timeZone: "Europe/Stockholm", change: "new" });
  return { source, item, event: firedOn(item) };
}

/** Each guest's answer on an event in the fake, in guest-list order. */
const answers = (id: string, calendarId = "primary") => google.event(id, calendarId)?.attendees?.map((a) => [a.email, a.responseStatus]);

describe("answering an invite", () => {
  it.each([
    ["accepts", accept, "accepted", 'accept "Budget review"'],
    ["declines", decline, "declined", 'decline "Budget review"'],
    ["answers maybe to", maybe, "tentative", 'answer maybe to "Budget review"'],
  ] as const)("%s an invite, telling the organizer and leaving the other guests as they were", async (_name, action, status, description) => {
    const { source, event } = await invited();

    await action().run(event, source);

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

  it("sends a note with the answer", async () => {
    const { source, event } = await invited();

    await decline({ comment: "I'm away that week." }).run(event, source);

    expect(google.calls("PATCH /calendars/primary/events/e1")[0]?.body).toEqual({
      attendeesOmitted: true,
      attendees: [{ email: "me@acme.com", responseStatus: "declined", comment: "I'm away that week." }],
    });
    expect(google.event("e1")?.attendees?.find((a) => a.self)?.comment).toBe("I'm away that week.");
    expect(decline({ comment: "x" }).describe(event)).toBe('decline "Budget review" with a note');
  });

  it("answers for the whole series when the event is one of a series", async () => {
    const { source, items } = await started(10);
    const standup = google.addEvent({
      summary: "Standup",
      recurrence: ["RRULE:FREQ=DAILY"],
      organizer: { email: "ann@example.com" },
      attendees: [{ email: "ann@example.com" }, { email: "me@acme.com" }],
    });
    await waitFor(() => items.length === 1);
    const event = firedOn(items[0]!);

    await accept().run(event, source);

    expect(google.calls(/^PATCH /).map((r) => r.path)).toEqual([`/calendars/primary/events/${standup.id}`]);
    expect(answers(standup.id)).toEqual([
      ["ann@example.com", "needsAction"],
      ["me@acme.com", "accepted"],
    ]);
    expect(accept().describe(event)).toBe('accept "Standup" (every occurrence)');
  });

  it("answers on the calendar the event is on", async () => {
    const team = "team@group.calendar.google.com";
    google.addCalendar(team, "Europe/Stockholm");
    const { source, event } = await invited({}, team);

    await accept().run(event, source);

    expect(google.calls(/^PATCH /).map((r) => r.path)).toEqual(["/calendars/team%40group.calendar.google.com/events/e1"]);
    expect(answers("e1", team)?.[1]).toEqual(["me@acme.com", "accepted"]);
  });

  it("refuses to answer an event you organized", async () => {
    const { source, event } = await invited({ organizer: { email: "me@acme.com" }, attendees: [{ email: "me@acme.com" }, { email: "bob@example.com" }] });

    await expect(accept().run(event, source)).rejects.toThrow(`You organized "Budget review", so there's no invite to answer.`);
    expect(google.calls(/^PATCH /)).toEqual([]);
  });

  it("refuses to answer an event you're not invited to", async () => {
    const { source, event } = await invited({ attendees: [{ email: "ann@example.com" }, { email: "bob@example.com" }] });

    await expect(decline().run(event, source)).rejects.toThrow(`You're not on the guest list of "Budget review".`);
    expect(google.calls(/^PATCH /)).toEqual([]);
  });

  it("reports what Google said when the answer fails", async () => {
    const { source, event } = await invited();
    google.fail("PATCH /calendars/primary/events/e1", 404);

    await expect(accept().run(event, source)).rejects.toThrow("Google PATCH /calendars/primary/events/e1 failed (404): Requested entity was not found.");
  });

  it("needs the Calendar source to have started", async () => {
    const { event } = await invited();

    await expect(accept().run(event, events({ auth: withTokens(google.tokens()) }))).rejects.toThrow(
      "Calendar actions need the Calendar source: google.calendar.events({ auth }).",
    );
  });
});

describe("with listen()", () => {
  const important = noul("Is this meeting important to me?");
  const jev = () => mockJev(({ state }) => ({ important: JSON.stringify(state).includes("Board") ? 0.95 : 0.05 }));
  const invite = (summary: string, organizer: string) =>
    google.addEvent({ summary, organizer: { email: organizer }, attendees: [{ email: organizer }, { email: "me@acme.com" }] });

  it("accepts important invites when armed, never a colleague's, and judges each once", async () => {
    const source = events({ auth: withTokens(google.tokens()), every: 10 });
    const actions: Array<ActionEvent<CalendarItem>> = [];
    const judged: Array<JudgedEvent<CalendarItem>> = [];
    const calendar = listen(source, { important }, { client: jev(), dryRun: false, log: silentLogger })
      .on("important", accept())
      .on("judged", (e) => void judged.push(e))
      .on("action", (e) => void actions.push(e));
    await calendar.start();

    invite("Board meeting", "chair@board.example");
    invite("Board prep", "ann@acme.com");
    invite("Lunch and learn", "events@vendor.example");
    await waitFor(() => actions.length === 2 && judged.length === 3);
    // Accepting changes the event on Google's side; that change isn't a new invite.
    const checked = google.calls("GET /calendars/primary/events").length;
    await waitFor(() => google.calls("GET /calendars/primary/events").length >= checked + 2);
    await calendar.stop();

    expect(actions.map((e) => [e.event.item.title, e.status, e.reason]).sort()).toEqual([
      ["Board meeting", "done", undefined],
      ["Board prep", "skipped", "colleague at acme.com"],
    ]);
    expect(answers("e1")?.[1]).toEqual(["me@acme.com", "accepted"]);
    expect(answers("e2")?.[1]).toEqual(["me@acme.com", "needsAction"]);
    expect(judged.map((e) => e.item.title)).toEqual(["Board meeting", "Board prep", "Lunch and learn"]);
  });

  it("only says what it would do in dry-run, the default", async () => {
    const source = events({ auth: withTokens(google.tokens()), every: 10 });
    const actions: Array<ActionEvent<CalendarItem>> = [];
    const calendar = listen(source, { important }, { client: jev(), log: silentLogger })
      .on("important", accept())
      .on("action", (e) => void actions.push(e));
    await calendar.start();

    invite("Board meeting", "chair@board.example");
    await waitFor(() => actions.length === 1);
    await calendar.stop();

    expect(actions.map((e) => [e.status, e.description])).toEqual([["dry-run", 'accept "Board meeting"']]);
    expect(google.calls(/^PATCH /)).toEqual([]);
  });
});
