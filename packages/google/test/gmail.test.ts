import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GoogleAuthError, inbox, withTokens, type GmailItem, type InboxOptions } from "@jev-events/google";

import { fakeGoogle, type FakeGoogle } from "./fake-google.js";
import { startSource, waitFor, type Started } from "./helpers.js";

let google: FakeGoogle;
let running: Array<Started<GmailItem>> = [];

beforeEach(async () => {
  google = await fakeGoogle();
});

afterEach(async () => {
  for (const run of running) run.stop();
  running = [];
  await google.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start an inbox source that checks every 10ms. */
function watch(options: Partial<InboxOptions> = {}) {
  const source = inbox({ auth: withTokens(google.tokens()), every: 10, ...options });
  const run = startSource(source);
  running.push(run);
  return { source, ...run };
}

/** Wait for `count` more history checks, so everything delivered before has been seen. */
async function polled(count = 2): Promise<void> {
  const target = google.calls("GET /history").length + count;
  await waitFor(() => google.calls("GET /history").length >= target, 2_000, `${count} more history checks`);
}

describe("inbox", () => {
  it("is a Gmail source that native actions can use", () => {
    const source = inbox({ auth: withTokens(google.tokens()) });

    expect(source).toMatchObject({ id: "gmail:inbox", platform: "gmail", noun: "email", canAct: true });
    expect(source.session).toBeUndefined();
  });

  it("emits new mail as it arrives, oldest first, once each", async () => {
    const { source, items, started } = watch();
    await started;
    // Delivered before the first check, so one check pages through all three.
    google.deliver({ from: "Ann <ann@example.com>", subject: "One" });
    google.deliver({ from: "Bob <bob@example.com>", subject: "Two" });
    google.deliver({ from: "Cy <cy@example.com>", subject: "Three" });

    await waitFor(() => items.length === 3);
    await polled();

    expect(items.map((item) => [item.id, item.subject])).toEqual([
      ["m1", "One"],
      ["m2", "Two"],
      ["m3", "Three"],
    ]);
    expect(items[0]).toMatchObject({ author: { email: "ann@example.com", name: "Ann" }, unread: true, labels: ["INBOX", "UNREAD"] });
    expect(source.session?.me).toBe("me@acme.com");

    const checks = google.calls("GET /history");
    expect(checks[0]?.query).toEqual({ startHistoryId: "1000", historyTypes: "messageAdded", labelId: "INBOX" });
    expect(checks[1]?.query.pageToken).toBe("2");
    expect(checks.at(-1)?.query.startHistoryId).toBe("1003");
    expect(google.calls("GET /messages/m1")).toHaveLength(1);
  });

  it("doesn't emit mail that was there before it started", async () => {
    google.deliver({ from: "ann@example.com", subject: "Old" });
    const { items, started } = watch();
    await started;

    await polled();

    expect(items).toEqual([]);
  });

  it("emits the latest emails already there when backfill asks, then new ones", async () => {
    google.deliver({ from: "a@example.com", subject: "Old" });
    google.deliver({ from: "b@example.com", subject: "Recent" });
    google.deliver({ from: "c@example.com", subject: "Latest" });
    const { items, started } = watch({ backfill: 2 });
    await started;
    await waitFor(() => items.length === 2);

    google.deliver({ from: "d@example.com", subject: "New" });
    await waitFor(() => items.length === 3);

    expect(items.map((item) => item.subject)).toEqual(["Recent", "Latest", "New"]);
    expect(google.calls("GET /messages")[0]?.query).toEqual({ labelIds: "INBOX", maxResults: "2" });
  });

  it("emits an email once when both the backfill and the history have it", async () => {
    google.deliver({ from: "a@example.com", subject: "Old" });
    const { items, started } = watch({ backfill: 5 });
    await started;
    // Arrives after the source read the history cursor but before the backfill lists the inbox.
    google.deliver({ from: "b@example.com", subject: "New" });

    await waitFor(() => items.length === 2);
    await polled();

    expect(items.map((item) => item.subject)).toEqual(["Old", "New"]);
    expect(google.calls("GET /messages/m2")).toHaveLength(1);
  });

  it("skips mail that was trashed, marked as spam or archived before it was fetched, and drafts", async () => {
    const { items, errors, started } = watch();
    await started;
    google.relabel(google.deliver({ from: "a@example.com", subject: "Trashed" }), { add: ["TRASH"], remove: ["INBOX"] });
    google.relabel(google.deliver({ from: "b@example.com", subject: "Spam" }), { add: ["SPAM"] });
    google.relabel(google.deliver({ from: "c@example.com", subject: "Archived" }), { remove: ["INBOX"] });
    google.deliver({ from: "me@acme.com", subject: "Draft", labels: ["INBOX", "DRAFT"] });
    google.deliver({ from: "d@example.com", subject: "Kept" });

    // Mail is handled in order, so once "Kept" is out the others were skipped.
    await waitFor(() => items.length === 1);

    expect(items.map((item) => item.subject)).toEqual(["Kept"]);
    expect(errors).toEqual([]);
  });

  it("skips mail deleted before it was fetched, without reporting an error", async () => {
    const { items, errors, started } = watch();
    await started;
    google.remove(google.deliver({ from: "a@example.com", subject: "Gone" }));
    google.deliver({ from: "b@example.com", subject: "Here" });

    await waitFor(() => items.length === 1);

    expect(items[0]?.subject).toBe("Here");
    expect(errors).toEqual([]);
    expect(google.calls("GET /messages/m1")).toHaveLength(1);
  });

  it("watches another label", async () => {
    const receipts = google.addLabel("Receipts");
    const { source, items, started } = watch({ label: receipts });
    await started;
    google.deliver({ from: "shop@example.com", subject: "Your receipt", labels: [receipts] });
    google.deliver({ from: "ann@example.com", subject: "Lunch?" });

    await waitFor(() => items.length === 1);
    await polled();

    expect(source.id).toBe("gmail:label_1");
    expect(items.map((item) => item.subject)).toEqual(["Your receipt"]);
    expect(google.calls("GET /history")[0]?.query.labelId).toBe(receipts);
  });

  it("starts over from now when Gmail's history cursor expired", async () => {
    const { items, warnings, started } = watch();
    await started;
    await polled(1);
    // Arrives while the source is paused for a week: Gmail no longer has the history.
    google.deliver({ from: "a@example.com", subject: "Missed" });
    google.expireHistory();

    await waitFor(() => {
      const reset = google.requests.findLastIndex((r) => r.path === "/profile");
      return google.calls("GET /profile").length === 2 && google.requests.slice(reset + 1).some((r) => r.path === "/history");
    });
    google.deliver({ from: "b@example.com", subject: "After" });
    await waitFor(() => items.length === 1);

    expect(warnings).toEqual(["Gmail's history cursor expired, so mail that arrived while paused is skipped."]);
    expect(items.map((item) => item.subject)).toEqual(["After"]);
  });

  it("reports an outage and keeps checking", async () => {
    const { items, errors, started } = watch();
    await started;
    // The first try and three retries.
    google.fail("GET /history", 503, { times: 4 });

    await waitFor(() => errors.length === 1);
    google.deliver({ from: "ann@example.com", subject: "After the outage" });
    await waitFor(() => items.length === 1);

    expect(errors[0]?.fatal).toBe(false);
    expect((errors[0]?.error as Error).message).toBe("Google GET /history failed (503): Backend Error");
  });

  it("reports an email it couldn't fetch and goes on with the next", async () => {
    const { items, errors, started } = watch();
    await started;
    google.fail("GET /messages/m1", 500, { times: 4 });
    google.deliver({ from: "a@example.com", subject: "Broken" });
    google.deliver({ from: "b@example.com", subject: "Fine" });

    await waitFor(() => items.length === 1);

    expect(items[0]?.subject).toBe("Fine");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fatal).toBe(false);
    expect((errors[0]?.error as Error).message).toBe("Google GET /messages/m1 failed (500): Backend Error");
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

  it("fails to start without Gmail access", async () => {
    google.fail("GET /profile", 403);

    const { started } = watch();

    await expect(started).rejects.toThrow("Request had insufficient authentication scopes. Sign in again and tick every box on Google's consent screen");
  });

  it("fails to start when you're signed out", async () => {
    const { started } = watch();
    google.expireAccessTokens();
    google.revoke();

    await expect(started).rejects.toBeInstanceOf(GoogleAuthError);
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
  it("protects you, colleagues and people you've emailed, and says why", async () => {
    google.emailed("friend@example.com");
    const { source, items, started } = watch();
    await started;
    google.deliver({ from: "Ann <ann@acme.com>", subject: "Colleague" });
    google.deliver({ from: "Friend <Friend@example.com>", subject: "Friend" });
    google.deliver({ from: "Deals <deals@shop.example>", subject: "Stranger" });
    google.deliver({ from: "Me <me@acme.com>", subject: "Note to self" });

    await waitFor(() => items.length === 4);

    expect(items.map((item) => [item.subject, source.isProtected?.(item)])).toEqual([
      ["Colleague", "colleague at acme.com"],
      ["Friend", "you've emailed friend@example.com before"],
      ["Stranger", false],
      ["Note to self", "from you"],
    ]);
    expect(items[1]?.facts).toMatchObject({ fromColleague: false, emailedBefore: true });
    expect(items[2]?.facts).toMatchObject({ fromColleague: false, emailedBefore: false });
  });

  it("protects whoever the protect option says", async () => {
    const off = watch({ protect: false });
    const custom = watch({ protect: { addresses: ["shop.example"], except: ["ann@acme.com"] } });
    await Promise.all([off.started, custom.started]);
    google.deliver({ from: "Ann <ann@acme.com>", subject: "Colleague" });
    google.deliver({ from: "deals@shop.example", subject: "Shop" });

    await waitFor(() => off.items.length === 2 && custom.items.length === 2);

    expect(off.items.map((item) => item.protectedBecause)).toEqual([undefined, undefined]);
    expect(custom.items.map((item) => item.protectedBecause)).toEqual([undefined, "on your protect list"]);
  });

  it("judges but doesn't act on mail when it can't check your Sent folder", async () => {
    const { items, warnings, started } = watch();
    await started;
    google.fail("GET /messages", 400);
    google.deliver({ from: "stranger@example.com", subject: "Hi" });

    await waitFor(() => items.length === 1);

    expect(items[0]?.protectedBecause).toBe("couldn't check your Sent folder");
    expect(warnings).toEqual(["Couldn't check whether you've emailed stranger@example.com before: Google GET /messages failed (400): Bad Request"]);
  });

  it("doesn't protect anyone it couldn't check when protection is off", async () => {
    const { items, warnings, started } = watch({ protect: false });
    await started;
    google.fail("GET /messages", 400);
    google.deliver({ from: "stranger@example.com", subject: "Hi" });

    await waitFor(() => items.length === 1);

    expect(items[0]?.protectedBecause).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});
