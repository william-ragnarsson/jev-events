import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { fileStore, memoryStore, monitor, noul, silentLogger, type Connection, type Item, type Source, type Store } from "jev-events";
import { mockJev } from "jev-events/testing";

import { events, fromEnv, GoogleApi, inbox, trash, withTokens, type CalendarItem, type GmailItem, type GoogleTokens } from "@jev-events/google";

// Gmail and Google Calendar against your real account, with Jev mocked. Reading runs whenever
// you've signed in; the checks that add and remove things run only with SMOKE_GOOGLE_WRITE=1.
// See smoke/README.md.

/** GOOGLE_CLIENT_ID and GOOGLE_REFRESH_TOKEN when set, otherwise what `npx jev-events auth google` saved. */
const account: Connection | undefined = process.env.GOOGLE_REFRESH_TOKEN
  ? fromEnv()
  : (await fileStore().connections.list({ integration: "google" })).find((connection) => connection.status === "active");
const write = process.env.SMOKE_GOOGLE_WRITE === "1";

const smokeTest = noul("Smoke test");

/** One check of `source` on your account, as a cron job would run it. Returns what it judged. */
async function check<I extends Item, P extends string, S>(source: Source<I, P, S>, store: Store): Promise<I[]> {
  const items: I[] = [];
  await monitor({ source, questions: { smokeTest }, client: mockJev(() => ({ smokeTest: 0 })), log: silentLogger })
    .on("judged", (event) => void items.push(event.item))
    .run({ store, connections: [account!] });
  return items;
}

/** Check again every few seconds until `found` says so, the way scheduled checks would. */
async function checkUntil(found: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const start = Date.now();
  while (!(await found())) {
    if (Date.now() - start > ms) throw new Error(`Waited ${Math.round(ms / 1000)}s for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

/** The Google API as your account, to add and inspect test data outside the monitor. */
const api = () => new GoogleApi(withTokens(account!.credentials as unknown as GoogleTokens));

describe.skipIf(!account)("google, signed in (real Gmail and Calendar)", () => {
  it("reads your latest emails", async () => {
    const emails = await check(inbox({ backfill: 3 }), memoryStore());

    expect(emails.length, "an email from your inbox (is it empty?)").toBeGreaterThan(0);
    for (const email of emails) {
      expect(email.labels).toContain("INBOX");
      expect(email.author.email).toContain("@");
      expect(email.text.length).toBeGreaterThan(0);
      expect(Number.isNaN(email.at.getTime())).toBe(false);
    }
  }, 60_000);

  it("reads your calendar", async () => {
    // Checking proves the sign-in, the Calendar permission and the sync; upcoming events are a bonus.
    const upcoming = await check(events({ backfill: 3 }), memoryStore());

    for (const event of upcoming) {
      expect(event.change).toBe("existing");
      expect(event.end.getTime()).toBeGreaterThanOrEqual(event.start.getTime());
      expect(event.end.getTime()).toBeGreaterThan(Date.now());
    }
  }, 60_000);

  it.skipIf(!write)("sees a new email arrive, then moves it to Trash", async () => {
    const store = memoryStore();
    await check(inbox(), store); // new mail counts from here
    const subject = `jev-events smoke test ${randomUUID().slice(0, 8)}`;
    const mime = [
      "From: jev-events smoke test <smoke@jev-events.invalid>",
      `To: ${String(account!.facts?.email ?? "me")}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      "The jev-events smoke test put this in your inbox, without sending anything. It moves it to Trash itself.",
    ].join("\r\n");

    // Put it straight in the inbox, the way mail arrives, without sending anything.
    await api().gmail("POST", "/messages", { body: { raw: Buffer.from(mime).toString("base64url"), labelIds: ["INBOX", "UNREAD"] } });
    const trashed: string[] = [];
    await checkUntil(
      async () => {
        await monitor({
          source: inbox(),
          questions: { smokeTest },
          client: mockJev(({ state }) => ({ smokeTest: JSON.stringify(state).includes(subject) ? 1 : 0 })),
          dryRun: false,
          log: silentLogger,
        })
          .on("smokeTest", trash())
          .on("action", (event) => void (event.status === "done" && trashed.push(event.event.item.id)))
          .run({ store, connections: [account!] });
        return trashed.length > 0;
      },
      60_000,
      `"${subject}" to arrive`,
    );

    const after = await api().gmail<{ labelIds: string[] }>("GET", `/messages/${trashed[0]}`, { query: { format: "minimal" } });
    expect(after.labelIds).toContain("TRASH");
  }, 90_000);

  it.skipIf(!write)("sees a new calendar event, then removes it", async () => {
    const store = memoryStore();
    await check(events(), store); // changes count from here
    const title = `jev-events smoke test ${randomUUID().slice(0, 8)}`;
    const start = new Date(Date.now() + 86_400_000);
    const created = await api().calendar<{ id: string }>("POST", "/calendars/primary/events", {
      body: {
        summary: title,
        description: "The jev-events smoke test made this and removes it itself.",
        start: { dateTime: start.toISOString() },
        end: { dateTime: new Date(start.getTime() + 1_800_000).toISOString() },
      },
    });

    try {
      let seen: CalendarItem | undefined;
      await checkUntil(
        async () => {
          seen = (await check(events(), store)).find((event) => event.title === title);
          return seen !== undefined;
        },
        60_000,
        `"${title}" to show up`,
      );
      expect(seen?.change).toBe("new");
      expect(seen?.organizer.you).toBe(true);
    } finally {
      // The test's own event, not yours, so it's removed rather than left in the trash.
      await api().calendar("DELETE", `/calendars/primary/events/${created.id}`);
    }
  }, 90_000);
});
