import { describe, expect, it } from "vitest";

import { bodyText, parseAddresses, stripQuoted, type EmailAddress, type GmailPart } from "@jev-events/google";

import { attachmentsOf, decodeWords, formatAddress, header } from "../src/gmail/message.js";
import { buildMessage } from "./fake-google.js";

const b64 = (text: string) => Buffer.from(text).toString("base64");

/** A text part as Gmail returns it: base64url data and a charset in Content-Type. */
function part(mimeType: string, data: Uint8Array | string, options: { charset?: string; filename?: string } = {}): GmailPart {
  return {
    mimeType,
    filename: options.filename ?? "",
    headers: [{ name: "Content-Type", value: `${mimeType}; charset="${options.charset ?? "UTF-8"}"` }],
    body: { data: Buffer.from(data).toString("base64url") },
  };
}

describe("parseAddresses", () => {
  it.each<[string, string, EmailAddress[]]>([
    ["a bare address", "ann@acme.com", [{ address: "ann@acme.com" }]],
    ["a name and address", "Ann Smith <ann@acme.com>", [{ name: "Ann Smith", address: "ann@acme.com" }]],
    [
      "a quoted name with a comma",
      '"Smith, Ann" <ann@acme.com>, bob@example.com',
      [{ name: "Smith, Ann", address: "ann@acme.com" }, { address: "bob@example.com" }],
    ],
    ["an escaped quote", '"Ann \\"The Boss\\" Smith" <ann@acme.com>', [{ name: 'Ann "The Boss" Smith', address: "ann@acme.com" }]],
    ["an encoded name", `=?UTF-8?B?${b64("Åsa Lindberg")}?= <asa@example.se>`, [{ name: "Åsa Lindberg", address: "asa@example.se" }]],
    ["a group", "Team: ann@acme.com, Bob <bob@acme.com>;", [{ address: "ann@acme.com" }, { name: "Bob", address: "bob@acme.com" }]],
    ["a comment", "ann@acme.com (Ann Smith)", [{ address: "ann@acme.com" }]],
    ["a name that's the address", "ann@acme.com <ann@acme.com>", [{ address: "ann@acme.com" }]],
    ["no one", "undisclosed-recipients:;", []],
    ["an empty header", "", []],
  ])("reads %s", (_name, value, expected) => {
    expect(parseAddresses(value)).toEqual(expected);
  });

  it("reads nothing from a missing header", () => {
    expect(parseAddresses(undefined)).toEqual([]);
  });

  it("formats an address back", () => {
    expect(formatAddress({ name: "Ann Smith", address: "ann@acme.com" })).toBe("Ann Smith <ann@acme.com>");
    expect(formatAddress({ address: "ann@acme.com" })).toBe("ann@acme.com");
  });
});

describe("decodeWords", () => {
  it("decodes base64 and quoted-printable words in any charset", () => {
    expect(decodeWords(`=?UTF-8?B?${b64("Möte på fredag")}?=`)).toBe("Möte på fredag");
    expect(decodeWords("=?ISO-8859-1?Q?M=F6te_p=E5_fredag?=")).toBe("Möte på fredag");
    expect(decodeWords("=?utf-8?q?Gr=C3=BC=C3=9Fe?=")).toBe("Grüße");
  });

  it("joins adjacent encoded words and keeps the plain text around them", () => {
    expect(decodeWords("=?UTF-8?Q?Hej?= =?UTF-8?Q?_d=C3=A4r?=")).toBe("Hej där");
    expect(decodeWords(`Re: =?UTF-8?B?${b64("Möte")}?= (moved)`)).toBe("Re: Möte (moved)");
    expect(decodeWords("Plain subject")).toBe("Plain subject");
  });

  it("falls back to UTF-8 for a charset it doesn't know, and drops a language tag", () => {
    expect(decodeWords(`=?x-unknown?B?${b64("Hi")}?=`)).toBe("Hi");
    expect(decodeWords("=?UTF-8*sv?Q?Hej?=")).toBe("Hej");
  });
});

describe("bodyText", () => {
  it("prefers the plain-text version", () => {
    expect(bodyText(buildMessage({ from: "ann@acme.com", text: "Plain", html: "<p>Rich</p>" }).payload)).toBe("Plain");
  });

  it("turns HTML into text when there's no plain version", () => {
    expect(bodyText(buildMessage({ from: "ann@acme.com", html: "<p>Hello <b>there</b></p>" }).payload)).toBe("Hello there");
  });

  it("uses the HTML when the plain version is blank", () => {
    expect(bodyText(buildMessage({ from: "ann@acme.com", text: "  \r\n ", html: "<p>Hi</p>" }).payload)).toBe("Hi");
  });

  it("normalizes line endings and trims", () => {
    expect(bodyText(buildMessage({ from: "ann@acme.com", text: "\r\nLine 1\r\nLine 2\r\n" }).payload)).toBe("Line 1\nLine 2");
  });

  it("decodes the part's charset", () => {
    expect(bodyText(part("text/plain", Uint8Array.from([0x48, 0xe4, 0x6a]), { charset: "iso-8859-1" }))).toBe("Häj");
  });

  it("doesn't read an attached text file as the body", () => {
    const payload: GmailPart = {
      mimeType: "multipart/mixed",
      parts: [part("text/html", "<p>Body</p>"), part("text/plain", "attachment text", { filename: "notes.txt" })],
    };
    expect(bodyText(payload)).toBe("Body");
  });

  it("is empty when there's no text", () => {
    expect(bodyText(undefined)).toBe("");
    expect(bodyText({ mimeType: "multipart/mixed", parts: [] })).toBe("");
  });
});

describe("attachmentsOf", () => {
  it("lists attached files but not images embedded in the HTML", () => {
    const message = buildMessage({
      from: "ann@acme.com",
      html: '<p>See attached</p><img src="cid:logo">',
      attachments: [
        { filename: "invoice.pdf", mimeType: "application/pdf", size: 52_000 },
        { filename: "logo.png", mimeType: "image/png", contentId: "logo" },
        { filename: "terms.pdf", mimeType: "application/pdf", size: 900, contentId: "terms" },
      ],
    });

    expect(attachmentsOf(message.payload)).toEqual([
      { filename: "invoice.pdf", mimeType: "application/pdf", size: 52_000 },
      { filename: "terms.pdf", mimeType: "application/pdf", size: 900 },
    ]);
    expect(bodyText(message.payload)).toBe("See attached");
  });
});

describe("header", () => {
  it("matches names in any case", () => {
    const payload = buildMessage({ from: "ann@acme.com", subject: "Lunch" }).payload;

    expect(header(payload, "subject")).toBe("Lunch");
    expect(header(payload, "MESSAGE-ID")).toBe("<m1@mail.example>");
    expect(header(payload, "X-Missing")).toBeUndefined();
    expect(header(undefined, "From")).toBeUndefined();
  });
});

describe("stripQuoted", () => {
  const REPLY = "Sounds good, see you then.";

  it.each<[string, string]>([
    ["English", "On Mon, 3 Mar 2025 at 10:00, Ann Smith <ann@acme.com> wrote:"],
    ["English, wrapped", "On Mon, 3 Mar 2025 at 10:00, Ann Smith <ann@acme.com>\nwrote:"],
    ["Swedish", "Den mån 3 mars 2025 kl 10:00 skrev Ann Smith <ann@acme.com>:"],
    ["Swedish, with på", "På måndag 3 mars 2025 skrev Ann Smith <ann@acme.com>:"],
    ["German", "Am Mo., 3. März 2025 um 10:00 Uhr schrieb Ann Smith <ann@acme.com>:"],
    ["French", "Le lun. 3 mars 2025 à 10:00, Ann Smith <ann@acme.com> a écrit :"],
    ["Spanish", "El lun, 3 mar 2025 a las 10:00, Ann Smith (<ann@acme.com>) escribió:"],
    ["Italian", "Il giorno lun 3 mar 2025 alle ore 10:00 Ann Smith <ann@acme.com> ha scritto:"],
    ["Portuguese", "Em seg., 3 de mar. de 2025 às 10:00, Ann Smith <ann@acme.com> escreveu:"],
    ["Dutch", "Op ma 3 mrt 2025 om 10:00 schreef Ann Smith <ann@acme.com>:"],
    ["Polish", "W dniu 3.03.2025 o 10:00, Ann Smith <ann@acme.com> napisał:"],
    ["Outlook", "From: Ann Smith <ann@acme.com>\nSent: Monday, March 3, 2025 10:00 AM\nTo: Me <me@acme.com>\nSubject: Lunch"],
    ["Swedish Outlook", "Från: Ann Smith <ann@acme.com>\nSkickat: den 3 mars 2025 10:00\nTill: Me <me@acme.com>\nÄmne: Lunch"],
    ["bold Outlook", "*From:* Ann Smith <ann@acme.com>\n*Sent:* Monday, March 3, 2025 10:00 AM"],
    ["Outlook rule", "________________________________\nFrom: Ann Smith <ann@acme.com>"],
    ["Original Message", "-----Original Message-----\nFrom: ann@acme.com"],
  ])("cuts the quote under a %s reply header", (_name, quoteHeader) => {
    expect(stripQuoted(`${REPLY}\n\n${quoteHeader}\n> Lunch on Friday?\n> Ann`)).toBe(REPLY);
  });

  it("drops quoted lines without a header", () => {
    expect(stripQuoted("Yes.\n> Can you make it?\n>> Earlier")).toBe("Yes.");
  });

  it("handles Windows line endings", () => {
    expect(stripQuoted("Yes!\r\n\r\nOn Mon, Ann wrote:\r\n> Hi")).toBe("Yes!");
  });

  it("keeps forwarded messages whole", () => {
    const gmail = "FYI, see below.\n\n---------- Forwarded message ---------\nFrom: Ann <ann@acme.com>\nDate: Mon, 3 Mar 2025\nSubject: Invoice\n\nPlease pay.";
    const apple = "FYI\n\nBegin forwarded message:\n\nFrom: Ann <ann@acme.com>\nSent: Monday\n\nPlease pay.";
    expect(stripQuoted(gmail)).toBe(gmail);
    expect(stripQuoted(apple)).toBe(apple);
  });

  it("keeps sentences that only start like a reply header", () => {
    const text = "On Monday Ann wrote the spec, and it's great.\nLe Mans was fun.\nPåminnelse: skrev du klart rapporten?\nAm I invited?";
    expect(stripQuoted(text)).toBe(text);
  });

  it("keeps everything when everything is quoted", () => {
    expect(stripQuoted("On Mon, Ann wrote:\n> Hi")).toBe("On Mon, Ann wrote:\n> Hi");
  });
});
