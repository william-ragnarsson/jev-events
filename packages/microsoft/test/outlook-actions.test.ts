import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { archive, categorize, draftReply, flag, inbox, markRead, move, trash } from "@jev-events/microsoft";

import { fakeMicrosoft, type FakeMail, type FakeMicrosoft } from "./fake-microsoft.js";
import { checker, connectionTo, firedOn } from "./helpers.js";

let microsoft: FakeMicrosoft;

beforeEach(async () => {
  microsoft = await fakeMicrosoft();
});

afterEach(async () => {
  await microsoft.close();
});

/** An email from Ann that the inbox source just read, ready for an action to run on. */
async function emailFromAnn(mail: Partial<FakeMail> = {}) {
  const run = checker(inbox(), { connection: connectionTo(microsoft) });
  await run.check();
  const id = microsoft.deliver({ from: "Ann Lee <ann@example.com>", subject: "Hello", ...mail });
  await run.check();
  const [item] = run.items;
  if (!item) throw new Error("The inbox didn't emit the email.");
  return { id, event: firedOn(item), ctx: await run.actionContext() };
}

describe("Outlook actions", () => {
  it("moves the email to Deleted Items, never deleting it for good", async () => {
    const { id, event, ctx } = await emailFromAnn();

    await trash().run(event, ctx);

    expect(microsoft.folderOf(id)).toBe("Deleted Items");
    expect(trash().describe(event)).toBe("move the email from Ann Lee to Deleted Items");
  });

  it("archives the email, and says what to use when there's no Archive folder", async () => {
    const { id, event, ctx } = await emailFromAnn();

    await archive().run(event, ctx);
    expect(microsoft.folderOf(id)).toBe("Archive");

    microsoft.removeFolder("archive");
    await expect(archive().run(event, ctx)).rejects.toThrow(
      `This mailbox has no Archive folder, so the email wasn't moved. Use microsoft.outlook.move("Done") instead, which makes the folder the first time.`,
    );
    expect(archive().describe(event)).toBe("archive the email from Ann Lee");
  });

  it("moves into a folder, making it the first time and reusing it after", async () => {
    const first = await emailFromAnn();
    const second = await emailFromAnn({ subject: "Again" });
    const action = move("Inbox/Receipts");

    await action.run(first.event, first.ctx);
    await action.run(second.event, first.ctx);

    expect([microsoft.folderOf(first.id), microsoft.folderOf(second.id)]).toEqual(["Inbox/Receipts", "Inbox/Receipts"]);
    expect(microsoft.requests.filter((r) => r.method === "POST" && r.path.endsWith("/childFolders"))).toHaveLength(1);
    expect(action.describe(first.event)).toBe('move the email from Ann Lee to "Inbox/Receipts"');
  });

  it("flags the email and marks it read", async () => {
    const { id, event, ctx } = await emailFromAnn();

    await flag().run(event, ctx);
    await markRead().run(event, ctx);

    expect(microsoft.calls(`PATCH /me/messages/${id}`).map((r) => r.body)).toEqual([{ flag: { flagStatus: "flagged" } }, { isRead: true }]);
    expect(microsoft.message(id)).toMatchObject({ flagged: true, isRead: true });
    expect([flag().describe(event), markRead().describe(event)]).toEqual(["flag the email from Ann Lee", "mark the email from Ann Lee as read"]);
  });

  it("adds a category, keeping the others and never adding it twice", async () => {
    const { id, event, ctx } = await emailFromAnn({ categories: ["Blue category"] });

    await categorize("Needs reply").run(event, ctx);
    await categorize("needs reply").run(event, ctx);

    expect(microsoft.message(id)?.categories).toEqual(["Blue category", "Needs reply"]);
    expect(microsoft.calls(`PATCH /me/messages/${id}`)).toHaveLength(1);
    expect(categorize("Needs reply").describe(event)).toBe('categorize the email from Ann Lee as "Needs reply"');
  });

  it("drafts a reply without sending it", async () => {
    const { id, event, ctx } = await emailFromAnn();

    await draftReply("Thanks, I'll look at it today.").run(event, ctx);
    await draftReply((e) => `Hi ${e.item.author.name}, thanks!`).run(event, ctx);

    expect(microsoft.drafts).toEqual([
      { replyTo: id, comment: "Thanks, I'll look at it today." },
      { replyTo: id, comment: "Hi Ann Lee, thanks!" },
    ]);
    expect(draftReply("x").describe(event)).toBe("draft a reply to Ann Lee (not sent)");
  });

  it("says which source its items come from when there's no session", async () => {
    const { event, ctx } = await emailFromAnn();

    await expect(trash().run(event, { ...ctx, session: undefined as never })).rejects.toThrow("Outlook actions run on items from microsoft.outlook.inbox().");
  });
});
