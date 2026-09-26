import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { archive, draftReply, gmailItem, inbox, label, markRead, star, trash, withTokens, type GmailItem } from "@jev-events/google";
import { listen, noul, silentLogger, type ActionEvent } from "jev-events";
import { mockJev } from "jev-events/testing";

import { decodeWords } from "../src/gmail/message.js";
import { fakeGoogle, type FakeGoogle, type FakeMail } from "./fake-google.js";
import { firedOn, startSource, waitFor, type Started } from "./helpers.js";

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

/** A started inbox source and one email in it, to run actions on directly. */
async function received(mail: Partial<FakeMail> = {}) {
  const source = inbox({ auth: withTokens(google.tokens()), every: "1h" });
  const run = startSource(source);
  running.push(run);
  await run.started;
  const id = google.deliver({ from: "Ann Smith <ann@example.com>", subject: "Lunch?", text: "Friday at 12?", ...mail });
  const item = gmailItem(structuredClone(google.message(id)!), { me: "me@acme.com" });
  return { source, item, event: firedOn(item) };
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
    const { source, event } = await received();

    await trash().run(event, source);

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
    const { source, event } = await received();

    await action().run(event, source);

    expect(google.calls("POST /messages/m1/modify").map((r) => r.body)).toEqual([change]);
    expect(action().describe(event)).toBe(description);
  });

  it("names the sender by address when there's no name", async () => {
    const { event } = await received({ from: "deals@shop.example" });

    expect(trash().describe(event)).toBe("move the email from deals@shop.example to Trash");
  });

  it("reports what Gmail said when an action fails", async () => {
    const { source, event } = await received();
    google.remove("m1");

    await expect(trash().run(event, source)).rejects.toThrow("Google POST /messages/m1/trash failed (404)");
  });

  it("needs the Gmail source to have started", async () => {
    const { event } = await received();

    await expect(trash().run(event, inbox({ auth: withTokens(google.tokens()) }))).rejects.toThrow(
      "Gmail actions need the Gmail source: google.gmail.inbox({ auth }).",
    );
  });
});

describe("label", () => {
  it("creates the label the first time, then reuses it", async () => {
    const { source, event } = await received();
    const second = firedOn(gmailItem(structuredClone(google.message(google.deliver({ from: "bob@example.com" }))!), { me: "me@acme.com" }));

    await label("Follow up").run(event, source);
    await label("follow UP").run(second, source);

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
    const { source, event } = await received();

    await label("receipts").run(event, source);

    expect(google.calls("POST /labels")).toEqual([]);
    expect(google.message("m1")?.labelIds).toContain(receipts);
  });

  it("uses the label someone else created a moment before", async () => {
    const { source, event } = await received();
    const receipts = google.addLabel("Receipts");
    // The first look doesn't see it yet, so creating it conflicts.
    google.fail("GET /labels", 200, { body: { labels: [] } });

    await label("Receipts").run(event, source);

    expect(google.calls(/\/labels$/).map((r) => r.method)).toEqual(["GET", "POST", "GET"]);
    expect(google.message("m1")?.labelIds).toContain(receipts);
  });

  it("tries creating it again after a failure", async () => {
    const { source, event } = await received();
    google.fail("POST /labels", 500, { times: 4 });

    await expect(label("Later").run(event, source)).rejects.toThrow("Google POST /labels failed (500)");
    await label("Later").run(event, source);

    expect(google.message("m1")?.labelIds).toContain("Label_1");
  });
});

describe("draftReply", () => {
  it("saves a threaded reply as a draft, never sending it", async () => {
    const { source, event } = await received();

    await draftReply("Friday works. See you then!").run(event, source);

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
    const { source, event } = await received();

    await draftReply((e) => `Hi ${e.item.from.name}, got it.`).run(event, source);

    expect(parseMime(google.drafts[0]!.mime).body).toBe("Hi Ann Smith, got it.");
  });

  it("replies to Reply-To, keeps an existing Re: and extends References", async () => {
    const { source, event } = await received({
      replyTo: "Billing <billing@example.com>",
      subject: "RE: Invoice",
      headers: { References: "<first@mail.example>" },
    });

    await draftReply("Paid.").run(event, source);

    expect(parseMime(google.drafts[0]!.mime).headers).toMatchObject({
      To: '"Billing" <billing@example.com>',
      Subject: "RE: Invoice",
      References: "<first@mail.example> <m1@mail.example>",
    });
  });

  it("encodes names and subjects outside ASCII, and wraps a long body", async () => {
    const subject = "Möte på fredag om budgeten för nästa kvartal och årets anställningar";
    const { source, event } = await received({ from: "Åsa Lindberg <asa@example.se>", subject });
    const text = `Tack! ${"Det låter bra. ".repeat(20)}`;

    await draftReply(text).run(event, source);

    const { headers, lines, body } = parseMime(google.drafts[0]!.mime);
    expect(decodeWords(headers.To ?? "")).toBe("Åsa Lindberg <asa@example.se>");
    expect(decodeWords(headers.Subject ?? "")).toBe(`Re: ${subject}`);
    expect(body).toBe(text);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(81);
  });
});

describe("with listen()", () => {
  const spam = noul("Is this email spam?");
  const jev = () => mockJev(({ state }) => ({ spam: JSON.stringify(state).includes("PRIZE") ? 0.97 : 0.02 }));

  it("trashes spam when armed, and never touches a colleague's email", async () => {
    const source = inbox({ auth: withTokens(google.tokens()), every: 10 });
    const actions: Array<ActionEvent<GmailItem>> = [];
    const mail = listen(source, { spam }, { client: jev(), dryRun: false, log: silentLogger })
      .on("spam", trash())
      .on("action", (e) => void actions.push(e));
    await mail.start();

    google.deliver({ from: "Deals <deals@shop.example>", subject: "You won a PRIZE" });
    google.deliver({ from: "Ann <ann@acme.com>", subject: "PRIZE draw for the team party" });
    google.deliver({ from: "Bob <bob@example.com>", subject: "Lunch?" });
    await waitFor(() => actions.length === 2);
    await mail.stop();

    expect(actions.map((e) => [e.event.item.subject, e.status, e.reason]).sort()).toEqual([
      ["PRIZE draw for the team party", "skipped", "colleague at acme.com"],
      ["You won a PRIZE", "done", undefined],
    ]);
    expect(google.message("m1")?.labelIds).toContain("TRASH");
    expect(google.message("m2")?.labelIds).toContain("INBOX");
    expect(google.message("m3")?.labelIds).toContain("INBOX");
  });

  it("only says what it would do in dry-run, the default", async () => {
    const source = inbox({ auth: withTokens(google.tokens()), every: 10 });
    const actions: Array<ActionEvent<GmailItem>> = [];
    const mail = listen(source, { spam }, { client: jev(), log: silentLogger })
      .on("spam", trash())
      .on("action", (e) => void actions.push(e));
    await mail.start();

    google.deliver({ from: "Deals <deals@shop.example>", subject: "You won a PRIZE" });
    await waitFor(() => actions.length === 1);
    await mail.stop();

    expect(actions.map((e) => [e.status, e.description])).toEqual([["dry-run", "move the email from Deals to Trash"]]);
    expect(google.calls("POST /messages/m1/trash")).toEqual([]);
  });
});
