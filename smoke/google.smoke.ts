import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { listen, noul, readCredentials, silentLogger, type AnySource, type Item, type Listener, type TriggeredEvent } from "jev-events";
import { mockJev } from "jev-events/testing";

import { events, fromEnv, fromFile, GoogleApi, inbox, trash, type CalendarItem, type GmailItem, type GoogleAuth } from "@jev-events/google";

import { waitFor } from "./helpers.js";

// Gmail and Google Calendar against your real account. Reading runs whenever you've signed in;
// the checks that add and remove things run only with SMOKE_GOOGLE_WRITE=1. See smoke/README.md.

const signedIn = Boolean(process.env.GOOGLE_REFRESH_TOKEN || readCredentials("google"));
const write = process.env.SMOKE_GOOGLE_WRITE === "1";

/** GOOGLE_CLIENT_ID and GOOGLE_REFRESH_TOKEN when set, otherwise what `npx jev-events auth google` saved. */
const signIn = (): GoogleAuth => (process.env.GOOGLE_REFRESH_TOKEN ? fromEnv() : fromFile());

let running: Array<Listener<AnySource, Record<string, ReturnType<typeof noul>>>> = [];

afterEach(async () => {
  await Promise.all(running.map((listener) => listener.stop()));
  running = [];
});

/** Start `source` with Jev mocked, and collect what it emits. */
async function watch<I extends Item>(source: AnySource): Promise<I[]> {
  const items: I[] = [];
  const listener = listen(source, { check: noul("Smoke test") }, { client: mockJev(() => ({ check: 0 })), log: silentLogger }).on("judged", (event) => {
    items.push(event.item as I);
  });
  running.push(listener);
  await listener.start();
  return items;
}

function firedOn<I extends Item>(item: I): TriggeredEvent<I> {
  return {
    item,
    answers: {},
    model: "smoke",
    latencyMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    cached: false,
    dryRun: false,
    protected: false,
    trigger: { event: "smoke", question: "smoke" },
  };
}

describe.skipIf(!signedIn)("google, signed in (real Gmail and Calendar)", () => {
  it("reads your latest emails", async () => {
    const emails = await watch<GmailItem>(inbox({ auth: signIn(), backfill: 3, every: "1h" }));

    await waitFor(() => emails.length > 0, 30_000, "an email from your inbox (is it empty?)");
    for (const email of emails) {
      expect(email.labels).toContain("INBOX");
      expect(email.author.email).toContain("@");
      expect(email.text.length).toBeGreaterThan(0);
      expect(Number.isNaN(email.at.getTime())).toBe(false);
    }
  });

  it("reads your calendar", async () => {
    // Starting proves the sign-in, the Calendar permission and the sync; upcoming events are a bonus.
    const upcoming = await watch<CalendarItem>(events({ auth: signIn(), backfill: 3, every: "1h" }));

    await new Promise((resolve) => setTimeout(resolve, 5_000));
    for (const event of upcoming) {
      expect(event.change).toBe("existing");
      expect(event.end.getTime()).toBeGreaterThanOrEqual(event.start.getTime());
      expect(event.end.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it.skipIf(!write)("sees a new email arrive, then moves it to Trash", async () => {
    const auth = signIn();
    const source = inbox({ auth, every: "3s" });
    const emails = await watch<GmailItem>(source);
    const subject = `jev-events smoke test ${randomUUID().slice(0, 8)}`;
    const mime = [
      "From: jev-events smoke test <smoke@jev-events.invalid>",
      `To: ${auth.email ?? "me"}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      "The jev-events smoke test put this in your inbox, without sending anything. It moves it to Trash itself.",
    ].join("\r\n");

    // Put it straight in the inbox, the way mail arrives, without sending anything.
    await new GoogleApi(auth).gmail("POST", "/messages", { body: { raw: Buffer.from(mime).toString("base64url"), labelIds: ["INBOX", "UNREAD"] } });
    await waitFor(() => emails.some((email) => email.subject === subject), 60_000, `"${subject}" to arrive`);
    const email = emails.find((e) => e.subject === subject)!;
    await trash().run(firedOn(email), source);

    const after = await new GoogleApi(auth).gmail<{ labelIds: string[] }>("GET", `/messages/${email.id}`, { query: { format: "minimal" } });
    expect(after.labelIds).toContain("TRASH");
  });

  it.skipIf(!write)("sees a new calendar event, then removes it", async () => {
    const auth = signIn();
    const api = new GoogleApi(auth);
    const upcoming = await watch<CalendarItem>(events({ auth, every: "3s" }));
    const title = `jev-events smoke test ${randomUUID().slice(0, 8)}`;
    const start = new Date(Date.now() + 86_400_000);
    const created = await api.calendar<{ id: string }>("POST", "/calendars/primary/events", {
      body: {
        summary: title,
        description: "The jev-events smoke test made this and removes it itself.",
        start: { dateTime: start.toISOString() },
        end: { dateTime: new Date(start.getTime() + 1_800_000).toISOString() },
      },
    });

    try {
      await waitFor(() => upcoming.some((event) => event.title === title), 60_000, `"${title}" to show up`);
      const event = upcoming.find((e) => e.title === title)!;
      expect(event.change).toBe("new");
      expect(event.organizer.you).toBe(true);
    } finally {
      await api.calendar("DELETE", `/calendars/primary/events/${created.id}`);
    }
  });
});
