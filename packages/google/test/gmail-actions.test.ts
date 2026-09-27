import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { archive, draftReply, inbox, label, markRead, star, trash, type GmailItem } from "@jev-events/google";
import { memoryStore, monitor, noul, silentLogger, type ActionEvent } from "jev-events";
import { mockJev } from "jev-events/testing";

import { decodeWords } from "../src/gmail/message.js";
import { fakeGoogle, type FakeGoogle, type FakeMail } from "./fake-google.js";
import { checker, connectionTo, firedOn } from "./helpers.js";

let google: FakeGoogle;

beforeEach(async () => {
  google = await fakeGoogle();
});

afterEach(async () => {
  await google.close();
});

/** Watch the inbox, then have one email arrive, to run actions on directly. */
async function received(mail: Partial<FakeMail> = {}) {
  const run = checker(inbox(), { connection: connectionTo(google) });
  await run.check();
  google.deliver({ from: "Ann Smith <ann@example.com>", subject: "Lunch?", text: "Friday at 12?", ...mail });
  await run.check();
  const item = run.items.at(-1)!;
  return { run, item, event: firedOn(item), ctx: await run.actionContext() };
}

/** Headers (unfolded) and the decoded body of a MIME message. */
function parseMime(mime: string): { headers: Record<string, string>; lines: string[]; body: string } {
  const [head = "", encoded = ""] = mime.split("\r\n\r\n");
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r\n /g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon)] = line.slice(colon + 1).trim();
  }
  return { headers, lines: mime.split("\r\n"), body: Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString("utf8") };
}

describe("label changes", () => {
  it("trashes an email, which Gmail keeps for 30 days", async () => {
    const { ctx, event } = await received();

    await trash().run(event, ctx);

    expect(google.calls("POST /messages/m1/trash")).toHaveLength(1);
    expect(google.message("m1")?.labelIds).toContain("TRASH");
    expect(google.message("m1")?.labelIds).not.toContain("INBOX");
    expect(trash().describe(event)).toBe("move the email from Ann Smith to Trash");
  });

  it.each([
    ["archives", archive, { removeLabelIds: ["INBOX"] }, "archive the email from Ann Smith"],
    ["marks as read", markRead, { removeLabelIds: ["UNREAD"] }, "mark the email from Ann Smith as read"],
    ["stars", star, { addLabelIds: ["STARRED"] }, "star the email from Ann Smith"],
  ])("%s an email", async (_name, action, change, description) => {
    const { ctx, event } = await received();

    await action().run(event, ctx);

    expect(google.calls("POST /messages/m1/modify").map((r) => r.body)).toEqual([change]);
    expect(action().describe(event)).toBe(description);
  });

  it("names the sender by address when there's no name", async () => {
    const { event } = await received({ from: "deals@shop.example" });

    expect(trash().describe(event)).toBe("move the email from deals@shop.example to Trash");
  });

  it("reports what Gmail said when an action fails", async () => {
    const { ctx, event } = await received();
    google.remove("m1");

    await expect(trash().run(event, ctx)).rejects.toThrow("Google POST /messages/m1/trash failed (404)");
  });

  it("runs only on items from the Gmail source", async () => {
    const { event, ctx } = await received();

    await expect(trash().run(event, { ...ctx, session: undefined as never })).rejects.toThrow(
      "Gmail actions run on items from google.gmail.inbox().",
    );
  });
});

describe("label", () => {
  it("creates the label the first time, then reuses it", async () => {
    const { run, ctx, event } = await received();
    google.deliver({ from: "bob@example.com" });
    await run.check();
    const second = firedOn(run.items.at(-1)!);

    await label("Follow up").run(event, ctx);
    await label("follow UP").run(second, ctx);

    expect(google.calls(/\/labels$/).map((r) => [r.method, r.body])).toEqual([
      ["GET", undefined],
      ["POST", { name: "Follow up", labelListVisibility: "labelShow", messageListVisibility: "show" }],
    ]);
    expect(google.message("m1")?.labelIds).toContain("Label_1");
    expect(google.message("m2")?.labelIds).toContain("Label_1");
    expect(label("Follow up").describe(event)).toBe('label the email from Ann Smith "Follow up"');
  });

  it("uses a label that already exists, whatever its case", async () => {
    const receipts = google.addLabel("Receipts");
    const { ctx, event } = await received();

    await label("receipts").run(event, ctx);

    expect(google.calls("POST /labels")).toEqual([]);
    expect(google.message("m1")?.labelIds).toContain(receipts);
  });

  it("uses the label someone else created a moment before", async () => {
    const { ctx, event } = await received();
    const receipts = google.addLabel("Receipts");
    // The first look doesn't see it yet, so creating it conflicts.
    google.fail("GET /labels", 200, { body: { labels: [] } });

    await label("Receipts").run(event, ctx);

    expect(google.calls(/\/labels$/).map((r) => r.method)).toEqual(["GET", "POST", "GET"]);
    expect(google.message("m1")?.labelIds).toContain(receipts);
  });

  it("tries creating it again after a failure", async () => {
    const { ctx, event } = await received();
    google.fail("POST /labels", 500, { times: 4 });

    await expect(label("Later").run(event, ctx)).rejects.toThrow("Google POST /labels failed (500)");
    await label("Later").run(event, ctx);

    expect(google.message("m1")?.labelIds).toContain("Label_1");
  });
});

describe("draftReply", () => {
  it("saves a threaded reply as a draft, never sending it", async () => {
    const { ctx, event } = await received();

    await draftReply("Friday works. See you then!").run(event, ctx);

    expect(google.drafts).toHaveLength(1);
    const draft = google.drafts[0]!;
    expect(draft.threadId).toBe("t-m1");
    const { headers, body } = parseMime(draft.mime);
    expect(headers).toMatchObject({
      To: '"Ann Smith" <ann@example.com>',
      Subject: "Re: Lunch?",
      "In-Reply-To": "<m1@mail.example>",
      References: "<m1@mail.example>",
      "Content-Type": 'text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding": "base64",
    });
    expect(body).toBe("Friday works. See you then!");
    expect(google.calls(/\/send$/)).toEqual([]);
    expect(draftReply("x").describe(event)).toBe("draft a reply to Ann Smith (not sent)");
  });

  it("writes the reply from the event", async () => {
    const { ctx, event } = await received();

    await draftReply((e) => `Hi ${e.item.from.name}, got it.`).run(event, ctx);

    expect(parseMime(google.drafts[0]!.mime).body).toBe("Hi Ann Smith, got it.");
  });

  it("replies to Reply-To, keeps an existing Re: and extends References", async () => {
    const { ctx, event } = await received({
      replyTo: "Billing <billing@example.com>",
      subject: "RE: Invoice",
      headers: { References: "<first@mail.example>" },
    });

    await draftReply("Paid.").run(event, ctx);

    expect(parseMime(google.drafts[0]!.mime).headers).toMatchObject({
      To: '"Billing" <billing@example.com>',
      Subject: "RE: Invoice",
      References: "<first@mail.example> <m1@mail.example>",
    });
  });

  it("encodes names and subjects outside ASCII, and wraps a long body", async () => {
    const subject = "Möte på fredag om budgeten för nästa kvartal och årets anställningar";
    const { ctx, event } = await received({ from: "Åsa Lindberg <asa@example.se>", subject });
    const text = `Tack! ${"Det låter bra. ".repeat(20)}`;

    await draftReply(text).run(event, ctx);

    const { headers, lines, body } = parseMime(google.drafts[0]!.mime);
    expect(decodeWords(headers.To ?? "")).toBe("Åsa Lindberg <asa@example.se>");
    expect(decodeWords(headers.Subject ?? "")).toBe(`Re: ${subject}`);
    expect(body).toBe(text);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(81);
  });
});

describe("in a monitor", () => {
  const spam = noul("Is this email spam?");
  const jev = () => mockJev(({ state }) => ({ spam: JSON.stringify(state).includes("PRIZE") ? 0.97 : 0.02 }));
  const connections = () => [connectionTo(google)];

  /** Check the inbox once to start from now, let `arrive()` deliver mail, then check again with `mail`. */
  async function twoChecks(arrive: () => void, dryRun?: boolean) {
    const store = memoryStore();
    await monitor({ source: inbox(), questions: { spam }, client: jev(), log: silentLogger }).run({ store, connections: connections() });
    arrive();
    const actions: Array<ActionEvent<GmailItem>> = [];
    const stats = await monitor({ source: inbox(), questions: { spam }, client: jev(), log: silentLogger, ...(dryRun === undefined ? {} : { dryRun }) })
      .on("spam", trash())
      .on("action", (e) => void actions.push(e))
      .run({ store, connections: connections() });
    return { actions, stats };
  }

  it("trashes spam when armed, and never touches a colleague's email", async () => {
    const { actions, stats } = await twoChecks(() => {
      google.deliver({ from: "Deals <deals@shop.example>", subject: "You won a PRIZE" });
      google.deliver({ from: "Ann <ann@acme.com>", subject: "PRIZE draw for the team party" });
      google.deliver({ from: "Bob <bob@example.com>", subject: "Lunch?" });
    }, false);

    expect(actions.map((e) => [e.event.item.subject, e.status, e.reason]).sort()).toEqual([
      ["PRIZE draw for the team party", "skipped", "colleague at acme.com"],
      ["You won a PRIZE", "done", undefined],
    ]);
    expect(stats).toMatchObject({ judged: 3, actions: { done: 1, skipped: 1 } });
    expect(google.message("m1")?.labelIds).toContain("TRASH");
    expect(google.message("m2")?.labelIds).toContain("INBOX");
    expect(google.message("m3")?.labelIds).toContain("INBOX");
  });

  it("only says what it would do in dry-run, the default", async () => {
    const { actions } = await twoChecks(() => {
      google.deliver({ from: "Deals <deals@shop.example>", subject: "You won a PRIZE" });
    });

    expect(actions.map((e) => [e.status, e.description])).toEqual([["dry-run", "move the email from Deals to Trash"]]);
    expect(google.calls("POST /messages/m1/trash")).toEqual([]);
  });

  it("reports an action Gmail refused, and goes on with the next email", async () => {
    google.fail("POST /messages/m1/trash", 500, { times: 4 });
    const { actions, stats } = await twoChecks(() => {
      google.deliver({ from: "Deals <deals@shop.example>", subject: "You won a PRIZE" });
      google.deliver({ from: "Promo <promo@shop.example>", subject: "Another PRIZE" });
    }, false);

    expect(actions.map((e) => [e.event.item.subject, e.status]).sort()).toEqual([
      ["Another PRIZE", "done"],
      ["You won a PRIZE", "failed"],
    ]);
    expect(stats.errors).toBe(1);
    expect(google.message("m2")?.labelIds).toContain("TRASH");
  });
});
