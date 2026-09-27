import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inbox, type InboxOptions, type OutlookCursor } from "@jev-events/microsoft";
import { needsSignIn } from "jev-events";

import { fakeMicrosoft, type FakeMicrosoft } from "./fake-microsoft.js";
import { checker, connectionTo } from "./helpers.js";

let microsoft: FakeMicrosoft;

beforeEach(async () => {
  microsoft = await fakeMicrosoft();
});

afterEach(async () => {
  await microsoft.close();
});

const watch = (options: InboxOptions = {}, connection = connectionTo(microsoft)) => checker(inbox(options), { connection });
const subjects = (items: Array<{ subject: string }>) => items.map((item) => item.subject);
const DAY = 24 * 60 * 60_000;

describe("outlook.inbox()", () => {
  it("starts from now, then emits new mail oldest first", async () => {
    microsoft.deliver({ from: "Old <old@example.com>", subject: "Before" });
    const mail = watch();

    await mail.check();
    microsoft.deliver({ from: "Ann Lee <ann@example.com>", subject: "Lunch?", text: "Are you free on Friday?", to: ["me@acme.com"] });
    microsoft.deliver({ from: "bob@example.com", subject: "Invoice" });
    await mail.check();

    expect(subjects(mail.items)).toEqual(["Lunch?", "Invoice"]);
    expect(mail.items[0]).toMatchObject({
      author: { name: "Ann Lee", email: "ann@example.com" },
      subject: "Lunch?",
      from: { name: "Ann Lee", address: "ann@example.com" },
      unread: true,
      flagged: false,
      mailingList: false,
    });
    expect(mail.items[0]?.text).toContain("Are you free on Friday?");
    expect(mail.errors).toEqual([]);
  });

  it("backfills the latest few emails on the first check", async () => {
    for (const subject of ["One", "Two", "Three"]) microsoft.deliver({ from: "ann@example.com", subject });

    const mail = watch({ backfill: 2 });
    await mail.check();

    expect(subjects(mail.items)).toEqual(["Two", "Three"]);
  });

  it("never emits an email twice, and still catches one that lands a little late", async () => {
    const mail = watch();
    await mail.check();
    microsoft.deliver({ from: "ann@example.com", subject: "First" });
    await mail.check();
    await mail.check();

    microsoft.deliver({ from: "bob@example.com", subject: "Late", receivedAt: Date.now() - 2 * 60_000 });
    await mail.check();

    expect(subjects(mail.items)).toEqual(["First", "Late"]);
    const filter = microsoft.calls("GET /me/mailFolders/inbox/messages").at(-1)?.query.$filter;
    expect(filter).toMatch(/^receivedDateTime ge \d{4}-\d\d-\d\dT/);
  });

  it("reads every page when a lot arrives at once", async () => {
    const mail = watch();
    await mail.check();
    for (let i = 0; i < 60; i++) microsoft.deliver({ from: "ann@example.com", subject: `Email ${i}` });

    await mail.check();

    expect(mail.items).toHaveLength(60);
    expect(mail.items.at(-1)?.subject).toBe("Email 59");
  });

  it("reads only the last week after a long pause, and says so", async () => {
    const mail = watch();
    await mail.check();
    const tenDaysAgo = new Date(Date.now() - 10 * DAY).toISOString();
    await mail.setCursor({ since: tenDaysAgo, seen: [], checkedAt: tenDaysAgo } satisfies OutlookCursor);
    microsoft.deliver({ from: "ann@example.com", subject: "Eight days ago", receivedAt: Date.now() - 8 * DAY });
    microsoft.deliver({ from: "ann@example.com", subject: "Today" });

    await mail.check();

    expect(subjects(mail.items)).toEqual(["Today"]);
    expect(mail.warnings).toContain("Outlook wasn't checked for over a week, so only mail from the last week is read.");
  });

  it("skips drafts and mail deleted before it's read", async () => {
    const mail = watch();
    await mail.check();
    microsoft.deliver({ from: "me@acme.com", subject: "Draft", isDraft: true });
    const gone = microsoft.deliver({ from: "ann@example.com", subject: "Gone" });
    microsoft.fail(`GET /me/messages/${gone}`, 404, { body: { error: { code: "ErrorItemNotFound", message: "The specified object was not found in the store." } } });
    microsoft.deliver({ from: "ann@example.com", subject: "Kept" });

    await mail.check();

    expect(subjects(mail.items)).toEqual(["Kept"]);
    expect(mail.errors).toEqual([]);
  });

  it("describes the Focused inbox, attachments and mailing lists", async () => {
    const mail = watch();
    await mail.check();
    microsoft.deliver({
      from: "News <news@example.com>",
      subject: "This week",
      html: "<p>Hello <b>there</b></p>",
      focused: false,
      headers: { "List-Unsubscribe": "<mailto:leave@example.com>" },
      attachments: [{ name: "report.pdf", contentType: "application/pdf", size: 1200 }],
    });

    await mail.check();

    const [item] = mail.items;
    expect(item).toMatchObject({ focused: false, mailingList: true, attachments: [{ filename: "report.pdf" }] });
    expect(item?.text).toContain("Hello there");
    expect(item?.text).not.toContain("<b>");
  });

  it("protects colleagues and people you've emailed, but not strangers", async () => {
    microsoft.emailed("bob@example.com");
    const mail = watch();
    await mail.check();
    microsoft.deliver({ from: "ann@acme.com", subject: "Colleague" });
    microsoft.deliver({ from: "bob@example.com", subject: "Friend" });
    microsoft.deliver({ from: "eve@example.org", subject: "Stranger" });

    await mail.check();

    expect(mail.items.map((item) => item.protectedBecause)).toEqual(["colleague at acme.com", "you've emailed bob@example.com before", undefined]);
  });

  it("protects no one with protect: false", async () => {
    const mail = watch({ protect: false });
    await mail.check();
    microsoft.deliver({ from: "ann@acme.com", subject: "Colleague" });

    await mail.check();

    expect(mail.items[0]?.protectedBecause).toBeUndefined();
  });

  it("plays safe when it can't search your Sent Items", async () => {
    const mail = watch();
    await mail.check();
    microsoft.fail("GET /me/mailFolders/sentitems/messages", 400, { body: { error: { code: "ErrorInvalidUrlQuery", message: "The search failed." } } });
    microsoft.deliver({ from: "eve@example.org", subject: "Stranger?" });

    await mail.check();

    expect(mail.items[0]?.protectedBecause).toBe("couldn't check your Sent Items");
    expect(mail.warnings.join("\n")).toContain("Couldn't check whether you've emailed eve@example.org before");
  });

  it("watches another folder", async () => {
    const receipts = microsoft.addFolder("Receipts", "inbox");
    const mail = watch({ folder: "Inbox/Receipts" });
    await mail.check();
    microsoft.deliver({ from: "shop@example.com", subject: "Receipt", folder: receipts });
    microsoft.deliver({ from: "ann@example.com", subject: "Not a receipt" });

    await mail.check();

    expect(subjects(mail.items)).toEqual(["Receipt"]);
    expect(inbox({ folder: "Inbox/Receipts" }).id).toBe("outlook:inbox/receipts");
  });

  it("saves renewed tokens with the connection", async () => {
    const mail = watch();
    microsoft.expireAccessTokens();

    await mail.check();

    expect(mail.saved).toHaveLength(1);
    expect(mail.saved[0]).toMatchObject({ accessToken: expect.stringMatching(/^access-/), refreshToken: expect.stringMatching(/^refresh-/) });
  });

  it("needs a new sign-in when Microsoft signed the account out", async () => {
    const mail = watch();
    await mail.check();
    microsoft.revoke();

    const error = await mail.check().then(() => undefined, (e: unknown) => e);

    expect(needsSignIn(error)).toBe(true);
  });

  it("needs a new sign-in when the account didn't allow reading mail", async () => {
    const mail = watch({}, connectionTo(microsoft, { scopes: ["openid", "User.Read"] }));

    const error = await mail.check().then(() => undefined, (e: unknown) => e);

    expect(needsSignIn(error)).toBe(true);
    expect((error as Error).message).toContain("Sign in again and allow every permission Microsoft asks for.");
  });
});
