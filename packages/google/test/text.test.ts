import { describe, expect, it } from "vitest";

import { htmlToText } from "@jev-events/google";

import { MAX_BODY_CHARS, truncate } from "../src/text.js";

describe("htmlToText", () => {
  it("turns paragraphs, breaks and headings into lines", () => {
    expect(htmlToText("<h1>Invoice</h1><p>Hi Ann,</p><p>Your invoice is ready.<br>Thanks!</p>")).toBe(
      "Invoice\n\nHi Ann,\n\nYour invoice is ready.\nThanks!",
    );
  });

  it("collapses the whitespace of the HTML source", () => {
    expect(htmlToText("<div>\n   Hello\n\n   world  </div>")).toBe("Hello world");
  });

  it("keeps a link's site next to its text, so a lookalike domain shows", () => {
    expect(htmlToText('<a href="https://paypa1.xyz/login?next=1">Log in to <b>PayPal</b></a>')).toBe("Log in to PayPal (paypa1.xyz)");
    expect(htmlToText("<a href='http://WWW.Acme.com:8080/docs'>Docs</a>")).toBe("Docs (acme.com)");
  });

  it("doesn't repeat a site the link text already names", () => {
    expect(htmlToText('<a href="https://www.acme.com/docs">acme.com/docs</a>')).toBe("acme.com/docs");
    expect(htmlToText('<a href="mailto:ann@acme.com">Ann</a>')).toBe("Ann");
    expect(htmlToText('<a href="https://acme.com"><img src="logo.png"></a>')).toBe("");
  });

  it("drops the head, styles, scripts and comments", () => {
    const html =
      "<html><head><title>Mail</title><style>p { color: red }</style></head><body><!-- tracking --><script>alert(1)</script><p>Hello</p></body></html>";
    expect(htmlToText(html)).toBe("Hello");
  });

  it("puts list items and table rows on their own lines", () => {
    expect(htmlToText("<p>Agenda:</p><ul><li>Budget</li><li>Hiring</li></ul>")).toBe("Agenda:\n\n- Budget\n- Hiring");
    expect(htmlToText("<table><tr><td>Total</td><td>$40</td></tr><tr><th>Due</th><td>Friday</td></tr></table>")).toBe("Total $40\n\nDue Friday");
  });

  it("decodes entities, including accented letters", () => {
    expect(htmlToText("Tom &amp; Jerry &lt;3 &quot;hi&quot; &#39;yo&#39; &#x1F600; &euro;5 &hellip;")).toBe(`Tom & Jerry <3 "hi" 'yo' 😀 €5 …`);
    expect(htmlToText("M&ouml;te p&aring; fredag, &Aring;sa. Caf&eacute; &agrave; Gr&uuml;n&szlig;e &AElig;&oslash;")).toBe(
      "Möte på fredag, Åsa. Café à Grünße Æø",
    );
  });

  it("keeps entities it doesn't know", () => {
    expect(htmlToText("&bogus; &#0; &#x110000;")).toBe("&bogus; &#0; &#x110000;");
  });

  it("turns non-breaking spaces into spaces and removes invisible characters", () => {
    expect(htmlToText("Price:&nbsp;&nbsp; 40&nbsp;kr")).toBe("Price: 40 kr");
    expect(htmlToText("Hi​‌͏­ there﻿&zwnj;")).toBe("Hi there");
  });
});

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("short")).toBe("short");
    expect(truncate("x".repeat(MAX_BODY_CHARS))).toHaveLength(MAX_BODY_CHARS);
  });

  it("cuts long text and marks the cut", () => {
    expect(truncate("x".repeat(MAX_BODY_CHARS + 1))).toBe(`${"x".repeat(MAX_BODY_CHARS)}…`);
    expect(truncate("word ".repeat(100), 10)).toBe("word word…");
  });
});
