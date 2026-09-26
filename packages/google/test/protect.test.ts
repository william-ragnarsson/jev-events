import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GoogleApi, People, protectedBecause, PUBLIC_DOMAINS, withTokens, type Person, type ProtectOptions } from "@jev-events/google";

import { domainOf, matchesAny } from "../src/protect.js";
import { fakeGoogle, googleError, type FakeGoogle } from "./fake-google.js";

let google: FakeGoogle;

beforeEach(async () => {
  google = await fakeGoogle();
});

afterEach(async () => {
  await google.close();
});

function people(me = "me@acme.com"): People {
  return new People(new GoogleApi(withTokens(google.tokens()), { retryBaseMs: 1 }), me);
}

const sentSearch = (address: string) => ({ q: `in:sent {to:${address} cc:${address} bcc:${address}}`, maxResults: "1" });

describe("matchesAny", () => {
  it.each<[string, string[], boolean]>([
    ["ann@acme.com", ["ann@acme.com"], true],
    [" Ann@ACME.com", ["ann@acme.com"], true],
    ["bob@acme.com", ["ann@acme.com"], false],
    ["ann@acme.com", ["acme.com"], true],
    ["ann@acme.com", ["@acme.com"], true],
    ["ann@eu.acme.com", ["acme.com"], true],
    ["ann@notacme.com", ["acme.com"], false],
    ["ann@acme.com.evil.io", ["acme.com"], false],
    ["ann@acme.com", ["example.org", "ACME.COM"], true],
    ["ann@acme.com", ["@"], false],
    ["ann@acme.com", [""], false],
    ["ann@acme.com", [], false],
  ])("%s against %j → %s", (address, patterns, expected) => {
    expect(matchesAny(address, patterns)).toBe(expected);
  });

  it("reads the domain from an address", () => {
    expect(domainOf(" Ann@Eu.Acme.COM ")).toBe("eu.acme.com");
  });
});

describe("People", () => {
  it("knows your company from your address, unless it's a public domain", () => {
    expect(people().company).toBe("acme.com");
    expect(people("Me@Acme.com").me).toBe("me@acme.com");
    expect(people("me@gmail.com").company).toBeUndefined();
    expect(people("me@hotmail.se").company).toBeUndefined();
    expect(PUBLIC_DOMAINS.has("outlook.com")).toBe(true);
  });

  it("tells you, colleagues and strangers apart", async () => {
    const p = people();

    expect(await p.about("Me@Acme.com")).toEqual({ address: "me@acme.com", you: true, colleague: false, emailedBefore: undefined });
    expect(await p.about("Ann@Acme.com")).toEqual({ address: "ann@acme.com", you: false, colleague: true, emailedBefore: false });
    expect(await p.about("ops@eu.acme.com")).toMatchObject({ colleague: true });
    expect(await p.about("eve@notacme.com")).toMatchObject({ colleague: false });
    // Your own address is never searched for.
    expect(google.calls("GET /messages")).toHaveLength(3);
  });

  it("has no colleagues on a public domain", async () => {
    expect(await people("me@gmail.com").about("friend@gmail.com")).toMatchObject({ colleague: false });
  });

  it("searches your Sent folder once per address", async () => {
    google.emailed("ann@example.com");
    const p = people();

    expect(await p.about("ann@example.com")).toMatchObject({ emailedBefore: true });
    expect(await p.about("ANN@example.com")).toMatchObject({ emailedBefore: true });
    expect(await p.emailedBefore("bob@example.com")).toBe(false);

    expect(google.calls("GET /messages").map((r) => r.query)).toEqual([sentSearch("ann@example.com"), sentSearch("bob@example.com")]);
  });

  it("asks once when the same address comes in twice at the same time", async () => {
    const p = people();

    await Promise.all([p.emailedBefore("ann@example.com"), p.emailedBefore("ann@example.com")]);

    expect(google.calls("GET /messages")).toHaveLength(1);
  });

  it("stops searching when it has no Gmail access", async () => {
    google.fail("GET /messages", 403);
    const p = people();

    expect(await p.emailedBefore("ann@example.com")).toBeUndefined();
    expect(await p.about("bob@example.com")).toMatchObject({ emailedBefore: undefined });
    expect(google.calls("GET /messages")).toHaveLength(1);
  });

  it("reports other errors and asks again next time", async () => {
    google.fail("GET /messages", 400);
    const p = people();

    await expect(p.emailedBefore("ann@example.com")).rejects.toThrow("Google GET /messages failed (400): Bad Request");

    google.emailed("ann@example.com");
    expect(await p.emailedBefore("ann@example.com")).toBe(true);
    expect(google.calls("GET /messages")).toHaveLength(2);
  });

  it("keeps searching after a rate limit", async () => {
    google.fail("GET /messages", 403, {
      times: 4,
      body: googleError(403, "Rate Limit Exceeded", "rateLimitExceeded", "PERMISSION_DENIED", "usageLimits"),
    });
    const p = people();

    await expect(p.emailedBefore("ann@example.com")).rejects.toThrow("Rate Limit Exceeded");
    expect(await p.emailedBefore("ann@example.com")).toBe(false);
  });
});

describe("protectedBecause", () => {
  const person = (overrides: Partial<Person> = {}): Person => ({
    address: "ann@example.com",
    you: false,
    colleague: false,
    emailedBefore: false,
    ...overrides,
  });
  const colleague = person({ address: "ann@acme.com", colleague: true, emailedBefore: true });

  it.each<[string, string | undefined, Person, ProtectOptions | false | undefined]>([
    ["a stranger", undefined, person(), undefined],
    ["someone it couldn't check", undefined, person({ emailedBefore: undefined }), undefined],
    ["you", "from you", person({ address: "me@acme.com", you: true, emailedBefore: undefined }), undefined],
    ["a colleague", "colleague at acme.com", colleague, undefined],
    ["someone you've emailed", "you've emailed ann@example.com before", person({ emailedBefore: true }), undefined],
    ["someone on your list", "on your protect list", person(), { addresses: ["@example.com"] }],
    ["a colleague when company is off", "you've emailed ann@acme.com before", colleague, { company: false }],
    ["someone you've emailed when that check is off", undefined, person({ emailedBefore: true }), { emailedBefore: false }],
    ["an exception", undefined, colleague, { except: ["ann@acme.com"] }],
    ["an exception that's also on your list", undefined, person(), { addresses: ["example.com"], except: ["example.com"] }],
    ["a colleague with protection off", undefined, colleague, false],
    ["you with protection off", undefined, person({ you: true }), false],
  ])("%s → %s", (_name, expected, who, options) => {
    expect(protectedBecause(who, options)).toBe(expected);
  });

  it("names your own items the way the caller says", () => {
    expect(protectedBecause(person({ you: true }), {}, "you organized it")).toBe("you organized it");
  });
});
