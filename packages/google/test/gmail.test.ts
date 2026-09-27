import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GoogleApiError, GoogleAuthError, inbox, type InboxOptions } from "@jev-events/google";
import { needsSignIn, toConnection } from "jev-events";

import { fakeGoogle, type FakeGoogle } from "./fake-google.js";
import { checker, connectionTo } from "./helpers.js";

let google: FakeGoogle;

beforeEach(async () => {
  google = await fakeGoogle();
});

afterEach(async () => {
  await google.close();
});

/** The inbox of the fake's account. Each `check()` is one scheduled check. */
function watch(options: InboxOptions = {}) {
  const source = inbox(options);
  return Object.assign(checker(source, { connection: connectionTo(google) }), { source });
}

/** A watch that has done its first check, so it emits what arrives from now on. */
async function watching(options: InboxOptions = {}) {
  const run = watch(options);
  await run.check();
  return run;
}

describe("inbox", () => {
  it("is a Gmail source for connected Google accounts that native actions can use", () => {
    expect(inbox()).toMatchObject({
      id: "gmail:inbox",
      platform: "gmail",
      noun: "email",
      canAct: true,
      integration: "google",
      defaults: { every: "15s" },
    });
  });

  it("takes the address saved at sign-in", async () => {
    const run = watch();

    expect((await run.session()).me).toBe("me@acme.com");
    expect(google.requests).toEqual([]);
  });

  it("asks Gmail for the address when the connection doesn't have it", async () => {
    const { credentials } = google.connection();
    const run = checker(inbox(), { connection: toConnection("google", { account: "google", credentials }) });

    expect((await run.session()).me).toBe("me@acme.com");
    expect(google.calls("GET /profile")).toHaveLength(1);
  });

  it("needs a connection", async () => {
    await expect(checker(inbox()).session()).rejects.toThrow(
      "gmail:inbox reads signed-in Google accounts, so it needs a connection. Sign in with npx jev-events auth google, or pass connections to start().",
    );
  });

  it("starts from now: mail already there isn't emitted", async () => {
    google.deliver({ from: "ann@example.com", subject: "Old" });
    const run = watch();

    await run.check();
    await run.check();

    expect(run.items).toEqual([]);
    expect(run.cursor).toEqual({ historyId: "1001" });
  });

  it("emits new mail oldest first, once each, paging through Gmail's history", async () => {
    const run = await watching();
    google.deliver({ from: "Ann <ann@example.com>", subject: "One" });
    google.deliver({ from: "Bob <bob@example.com>", subject: "Two" });
    google.deliver({ from: "Cy <cy@example.com>", subject: "Three" });

    await run.check();
    await run.check();

    expect(run.items.map((item) => [item.id, item.subject])).toEqual([
      ["m1", "One"],
      ["m2", "Two"],
      ["m3", "Three"],
    ]);
    expect(run.items[0]).toMatchObject({ author: { email: "ann@example.com", name: "Ann" }, unread: true, labels: ["INBOX", "UNREAD"] });
    const checks = google.calls("GET /history");
    expect(checks[0]?.query).toEqual({ startHistoryId: "1000", historyTypes: "messageAdded", labelId: "INBOX" });
    expect(checks[1]?.query.pageToken).toBe("2");
    expect(checks.at(-1)?.query.startHistoryId).toBe("1003");
    expect(run.cursor).toEqual({ historyId: "1003" });
    expect(google.calls("GET /messages/m1")).toHaveLength(1);
  });

  it("emits the latest emails already there when backfill asks, then new ones", async () => {
    google.deliver({ from: "a@example.com", subject: "Old" });
    google.deliver({ from: "b@example.com", subject: "Recent" });
    google.deliver({ from: "c@example.com", subject: "Latest" });
    const run = watch({ backfill: 2 });

    await run.check();
    expect(run.cursor).toEqual({ historyId: "1003", backfilled: ["m2", "m3"] });
    google.deliver({ from: "d@example.com", subject: "New" });
    await run.check();

    expect(run.items.map((item) => item.subject)).toEqual(["Recent", "Latest", "New"]);
    expect(google.calls("GET /messages")[0]?.query).toEqual({ labelIds: "INBOX", maxResults: "2" });
    expect(run.cursor).toEqual({ historyId: "1004" });
  });

  it("emits an email once when both the backfill and the history have it", async () => {
    google.deliver({ from: "a@example.com", subject: "Old" });
    // Arrives after the first check read the history ID, but before it listed the inbox.
    google.fail("GET /messages", 503, { run: () => void google.deliver({ from: "b@example.com", subject: "New" }) });
    const run = watch({ backfill: 5 });

    await run.check();
    await run.check();

    expect(run.items.map((item) => item.subject)).toEqual(["Old", "New"]);
    expect(google.calls("GET /messages/m2")).toHaveLength(1);
  });

  it("skips mail that was trashed, marked as spam or archived before it was fetched, and drafts", async () => {
    const run = await watching();
    google.relabel(google.deliver({ from: "a@example.com", subject: "Trashed" }), { add: ["TRASH"], remove: ["INBOX"] });
    google.relabel(google.deliver({ from: "b@example.com", subject: "Spam" }), { add: ["SPAM"] });
    google.relabel(google.deliver({ from: "c@example.com", subject: "Archived" }), { remove: ["INBOX"] });
    google.deliver({ from: "me@acme.com", subject: "Draft", labels: ["INBOX", "DRAFT"] });
    google.deliver({ from: "d@example.com", subject: "Kept" });

    await run.check();

    expect(run.items.map((item) => item.subject)).toEqual(["Kept"]);
    expect(run.errors).toEqual([]);
  });

  it("skips mail deleted before it was fetched, without reporting an error", async () => {
    const run = await watching();
    google.remove(google.deliver({ from: "a@example.com", subject: "Gone" }));
    google.deliver({ from: "b@example.com", subject: "Here" });

    await run.check();

    expect(run.items.map((item) => item.subject)).toEqual(["Here"]);
    expect(run.errors).toEqual([]);
    expect(google.calls("GET /messages/m1")).toHaveLength(1);
  });

  it("watches another label", async () => {
    const receipts = google.addLabel("Receipts");
    const run = await watching({ label: receipts });
    google.deliver({ from: "shop@example.com", subject: "Your receipt", labels: [receipts] });
    google.deliver({ from: "ann@example.com", subject: "Lunch?" });

    await run.check();

    expect(run.source.id).toBe("gmail:label_1");
    expect(run.items.map((item) => item.subject)).toEqual(["Your receipt"]);
    expect(google.calls("GET /history")[0]?.query.labelId).toBe(receipts);
  });

  it("starts over from now when Gmail's history cursor expired", async () => {
    const run = await watching();
    // Arrives while monitoring is paused for a week: Gmail no longer has the history.
    google.deliver({ from: "a@example.com", subject: "Missed" });
    google.expireHistory();

    await run.check();
    google.deliver({ from: "b@example.com", subject: "After" });
    await run.check();

    expect(run.warnings).toEqual(["Gmail's history cursor expired, so mail that arrived while paused is skipped."]);
    expect(run.items.map((item) => item.subject)).toEqual(["After"]);
  });

  it("throws an outage, so the next check picks up where this one would have", async () => {
    const run = await watching();
    google.deliver({ from: "ann@example.com", subject: "During the outage" });
    // The first try and three retries.
    google.fail("GET /history", 503, { times: 4 });

    const error = await run.check().catch((error: unknown) => error);
    await run.check();

    expect(error).toBeInstanceOf(GoogleApiError);
    expect((error as Error).message).toBe("Google GET /history failed (503): Backend Error");
    expect(needsSignIn(error)).toBe(false);
    expect(run.items.map((item) => item.subject)).toEqual(["During the outage"]);
  });

  it("reports an email it couldn't fetch and goes on with the next", async () => {
    const run = await watching();
    google.fail("GET /messages/m1", 500, { times: 4 });
    google.deliver({ from: "a@example.com", subject: "Broken" });
    google.deliver({ from: "b@example.com", subject: "Fine" });

    await run.check();

    expect(run.items.map((item) => item.subject)).toEqual(["Fine"]);
    expect(run.errors).toHaveLength(1);
    expect(run.errors[0]?.fatal).toBe(false);
    expect((run.errors[0]?.error as Error).message).toBe("Google GET /messages/m1 failed (500): Backend Error");
  });

  it("asks for a new sign-in when Google signed the account out", async () => {
    const run = await watching();
    google.expireAccessTokens();
    google.revoke();

    const error = await run.check().catch((error: unknown) => error);

    expect(error).toBeInstanceOf(GoogleAuthError);
    expect(needsSignIn(error)).toBe(true);
    expect(run.items).toEqual([]);
  });

  it("asks for a new sign-in when the account didn't allow Gmail", async () => {
    google.fail("GET /profile", 403);

    const error = await watch().check().catch((error: unknown) => error);

    expect((error as Error).message).toContain("Request had insufficient authentication scopes. Sign in again and tick every box on Google's consent screen.");
    expect(needsSignIn(error)).toBe(true);
  });

  it("saves the renewed token when the old one expired", async () => {
    const run = await watching();
    google.expireAccessTokens();
    google.deliver({ from: "ann@example.com", subject: "Hi" });

    await run.check();

    expect(run.items).toHaveLength(1);
    expect(run.saved).toEqual([expect.objectContaining({ accessToken: "access-2", refreshToken: "refresh-1" })]);
  });

  it("stops emitting when stopped, and leaves the cursor for the next run", async () => {
    const run = await watching();
    google.deliver({ from: "ann@example.com", subject: "Hi" });

    run.abort();
    await run.check();

    expect(run.items).toEqual([]);
    expect(run.cursor).toEqual({ historyId: "1000" });
  });
});

describe("protection", () => {
  it("protects you, colleagues and people you've emailed, and says why", async () => {
    google.emailed("friend@example.com");
    const run = await watching();
    google.deliver({ from: "Ann <ann@acme.com>", subject: "Colleague" });
    google.deliver({ from: "Friend <Friend@example.com>", subject: "Friend" });
    google.deliver({ from: "Deals <deals@shop.example>", subject: "Stranger" });
    google.deliver({ from: "Me <me@acme.com>", subject: "Note to self" });

    await run.check();
    const ctx = { connection: undefined, session: await run.session() };

    expect(run.items.map((item) => [item.subject, run.source.isProtected?.(item, ctx)])).toEqual([
      ["Colleague", "colleague at acme.com"],
      ["Friend", "you've emailed friend@example.com before"],
      ["Stranger", false],
      ["Note to self", "from you"],
    ]);
    expect(run.items[1]?.facts).toMatchObject({ fromColleague: false, emailedBefore: true });
    expect(run.items[2]?.facts).toMatchObject({ fromColleague: false, emailedBefore: false });
  });

  it("protects whoever the protect option says", async () => {
    const off = await watching({ protect: false });
    const custom = await watching({ protect: { addresses: ["shop.example"], except: ["ann@acme.com"] } });
    google.deliver({ from: "Ann <ann@acme.com>", subject: "Colleague" });
    google.deliver({ from: "deals@shop.example", subject: "Shop" });

    await off.check();
    await custom.check();

    expect(off.items.map((item) => item.protectedBecause)).toEqual([undefined, undefined]);
    expect(custom.items.map((item) => item.protectedBecause)).toEqual([undefined, "on your protect list"]);
  });

  it("judges but doesn't act on mail when it can't check your Sent folder", async () => {
    const run = await watching();
    google.fail("GET /messages", 400);
    google.deliver({ from: "stranger@example.com", subject: "Hi" });

    await run.check();

    expect(run.items[0]?.protectedBecause).toBe("couldn't check your Sent folder");
    expect(run.warnings).toEqual(["Couldn't check whether you've emailed stranger@example.com before: Google GET /messages failed (400): Bad Request"]);
  });

  it("doesn't protect anyone it couldn't check when protection is off", async () => {
    const run = await watching({ protect: false });
    google.fail("GET /messages", 400);
    google.deliver({ from: "stranger@example.com", subject: "Hi" });

    await run.check();

    expect(run.items[0]?.protectedBecause).toBeUndefined();
    expect(run.warnings).toHaveLength(1);
  });
});
