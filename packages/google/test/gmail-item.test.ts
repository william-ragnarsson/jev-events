import { describe, expect, it } from "vitest";

import { describeEmail, gmailItem, type GmailItemContext, type Person } from "@jev-events/google";

import { buildMessage, type FakeMail } from "./fake-google.js";

const ME: GmailItemContext = { me: "me@acme.com" };
const stranger: Person = { address: "ann@example.com", you: false, colleague: false, emailedBefore: false };

/** An email from Ann to you, with the parts a test changes. */
const email = (mail: Partial<FakeMail> = {}, id = "m1") => buildMessage({ from: "Ann <ann@example.com>", text: "Hi", ...mail }, { id });

describe("gmailItem", () => {
  it("reads everything a handler needs from a reply with an attachment", () => {
    const message = buildMessage(
      {
        from: '"Smith, Ann" <Ann@Example.com>',
        to: "Me@Acme.com, bob@acme.com",
        cc: "Carl <carl@acme.com>",
        replyTo: "billing@example.com",
        subject: "  Re: Invoice for March  ",
        text: "Please pay by Friday.\n\nOn Mon, 3 Mar 2025 at 10:00, Me <me@acme.com> wrote:\n> Where's the invoice?",
        attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", size: 52_000 }],
        headers: { "In-Reply-To": "<earlier@mail.example>", References: "<earlier@mail.example>" },
        labels: ["INBOX", "UNREAD", "IMPORTANT", "CATEGORY_UPDATES"],
      },
      { id: "m7", internalDate: Date.UTC(2025, 2, 3, 10, 5) },
    );

    const item = gmailItem(message, { me: "me@acme.com", sender: { ...stranger, emailedBefore: true } });

    expect(item).toEqual({
      id: "m7",
      text: "Re: Invoice for March\n\nPlease pay by Friday.",
      author: { id: "ann@example.com", name: "Smith, Ann", email: "ann@example.com" },
      at: new Date(Date.UTC(2025, 2, 3, 10, 5)),
      facts: {
        toYouDirectly: true,
        mailingList: false,
        isReply: true,
        fromColleague: false,
        emailedBefore: true,
        attachments: ["invoice.pdf"],
        category: "updates",
      },
      raw: message,
      threadId: "t-m7",
      subject: "Re: Invoice for March",
      body: "Please pay by Friday.",
      from: { name: "Smith, Ann", address: "Ann@Example.com" },
      to: [{ address: "Me@Acme.com" }, { address: "bob@acme.com" }],
      cc: [{ name: "Carl", address: "carl@acme.com" }],
      replyTo: { address: "billing@example.com" },
      snippet: "Please pay by Friday. On Mon, 3 Mar 2025 at 10:00, Me <me@acme.com> wrote: > Where's the invoice?",
      labels: ["INBOX", "UNREAD", "IMPORTANT", "CATEGORY_UPDATES"],
      unread: true,
      attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", size: 52_000 }],
      messageId: "<m7@mail.example>",
      references: "<earlier@mail.example>",
      category: "updates",
      mailingList: false,
    });
  });

  it("turns an HTML-only email into text", () => {
    const item = gmailItem(email({ text: undefined, html: '<p>Your <a href="https://paypa1.xyz">PayPal</a> account is locked.</p>' }), ME);

    expect(item.body).toBe("Your PayPal (paypa1.xyz) account is locked.");
  });

  it("falls back to the snippet and to (no subject)", () => {
    const message = { ...email({ text: "", headers: { Subject: undefined } }), snippet: "Tom &amp; Jerry &quot;hi&quot; &#39;yo&#39; &lt;3 &amp;lt;" };

    const item = gmailItem(message, ME);

    expect(item.subject).toBe("");
    expect(item.body).toBe("");
    expect(item.snippet).toBe(`Tom & Jerry "hi" 'yo' <3 &lt;`);
    expect(item.text).toBe(`(no subject)\n\nTom & Jerry "hi" 'yo' <3 &lt;`);
    expect(describeEmail(item)).toMatchObject({ body: item.snippet });
  });

  it("caps a long body", () => {
    const item = gmailItem(email({ text: "x".repeat(10_000) }), ME);

    expect(item.body).toBe(`${"x".repeat(4_000)}…`);
  });

  it("names an email without a sender 'unknown'", () => {
    const item = gmailItem(email({ headers: { From: undefined } }), ME);

    expect(item.from).toEqual({ address: "unknown" });
    expect(item.author).toEqual({ id: "unknown", name: "unknown", email: "unknown" });
  });

  it("leaves out Reply-To when it's the sender", () => {
    expect(gmailItem(email({ replyTo: "ANN@example.com" }), ME)).not.toHaveProperty("replyTo");
  });

  it("uses the time it arrived, or now when Gmail doesn't say", () => {
    const now = Date.now();
    const item = gmailItem({ ...email(), internalDate: undefined }, ME);

    expect(item.at.getTime()).toBeGreaterThanOrEqual(now);
    expect(item.at.getTime()).toBeLessThan(now + 1_000);
  });

  it.each<[string, string | undefined, Record<string, string>, boolean]>([
    ["Re:", "Re: Lunch", {}, true],
    ["Swedish SV:", "SV: Lunch", {}, true],
    ["German AW:", "aw: Lunch", {}, true],
    ["Dutch Antw:", "Antw: Lunch", {}, true],
    ["Finnish VS:", "VS: Lunch", {}, true],
    ["an In-Reply-To header", "Lunch", { "In-Reply-To": "<x@mail.example>" }, true],
    ["a new thread", "Lunch", {}, false],
    ["a word that starts like Re", "Regarding lunch", {}, false],
    ["no subject", undefined, {}, false],
  ])("isReply for %s → %s", (_name, subject, headers, expected) => {
    const item = gmailItem(email({ headers: { Subject: subject, ...headers } }), ME);

    expect(item.facts?.isReply).toBe(expected);
  });

  it.each<[string, Record<string, string>, boolean]>([
    ["List-Id", { "List-Id": "<news.example.com>" }, true],
    ["List-Unsubscribe", { "List-Unsubscribe": "<mailto:unsub@example.com>" }, true],
    ["Precedence: bulk", { Precedence: "Bulk" }, true],
    ["Precedence: list", { Precedence: "list" }, true],
    ["Precedence: junk", { Precedence: "junk" }, false],
    ["a personal email", {}, false],
  ])("mailingList for %s → %s", (_name, headers, expected) => {
    const item = gmailItem(email({ headers }), ME);

    expect(item.mailingList).toBe(expected);
    expect(item.facts?.mailingList).toBe(expected);
  });

  it("knows whether the email was sent to you or only copied you", () => {
    expect(gmailItem(email({ to: "Me <ME@acme.com>" }), ME).facts?.toYouDirectly).toBe(true);
    expect(gmailItem(email({ to: "team@acme.com", cc: "me@acme.com" }), ME).facts?.toYouDirectly).toBe(false);
  });

  it("adds the facts it knows about the sender, and leaves out the ones it doesn't", () => {
    expect(gmailItem(email(), ME).facts).toEqual({ toYouDirectly: true, mailingList: false, isReply: false });
    expect(gmailItem(email(), { ...ME, sender: { ...stranger, colleague: true, emailedBefore: undefined } }).facts).toEqual({
      toYouDirectly: true,
      mailingList: false,
      isReply: false,
      fromColleague: true,
    });
  });

  it("reads the inbox tab and the unread state from the labels", () => {
    const item = gmailItem(email({ labels: ["INBOX", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"] }), ME);
    expect(item.category).toBe("promotions");
    expect(item.unread).toBe(false);

    const plain = gmailItem(email({ labels: ["INBOX"] }), ME);
    expect(plain).not.toHaveProperty("category");
    expect(plain.facts).not.toHaveProperty("category");
  });

  it("carries why the email is protected", () => {
    expect(gmailItem(email(), { ...ME, protectedBecause: "colleague at acme.com" }).protectedBecause).toBe("colleague at acme.com");
    expect(gmailItem(email(), ME)).not.toHaveProperty("protectedBecause");
  });
});

describe("describeEmail", () => {
  it("shows Jev the sender, subject, new text and facts", () => {
    const item = gmailItem(
      email({ from: "Ann Smith <ann@example.com>", subject: "Lunch?", text: "Friday at 12?\n\n> earlier", attachments: [{ filename: "menu.pdf", mimeType: "application/pdf" }] }),
      { ...ME, sender: stranger },
    );

    expect(describeEmail(item)).toEqual({
      from: "Ann Smith <ann@example.com>",
      subject: "Lunch?",
      body: "Friday at 12?",
      toYouDirectly: true,
      mailingList: false,
      isReply: false,
      fromColleague: false,
      emailedBefore: false,
      attachments: ["menu.pdf"],
    });
  });
});
