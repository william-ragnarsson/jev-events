import { describe, expect, it, vi } from "vitest";

import { burst, listen, noul, silentLogger, toMs, webhook, type Item } from "../src/index.js";
import { mockJev } from "../src/testing.js";

describe("burst", () => {
  it("fires once when enough distinct keys trigger inside the window, then cools down", () => {
    let now = 0;
    const handler = vi.fn();
    const onEvent = burst<{ who: string }>({ count: 3, within: "30s", distinctBy: (e) => e.who, now: () => now }, handler);

    onEvent({ who: "a" });
    onEvent({ who: "a" }); // same person twice counts once
    onEvent({ who: "b" });
    expect(handler).not.toHaveBeenCalled();

    now = 10_000;
    onEvent({ who: "c" });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0].events.map((e: { who: string }) => e.who)).toEqual(["a", "b", "c"]);

    now = 20_000; // still cooling down
    for (const who of ["d", "e", "f"]) onEvent({ who });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("forgets triggers that fall out of the window", () => {
    let now = 0;
    const handler = vi.fn();
    const onEvent = burst<string>({ count: 2, within: "10s", now: () => now }, handler);
    onEvent("first");
    now = 11_000;
    onEvent("second");
    expect(handler).not.toHaveBeenCalled();
    now = 12_000;
    onEvent("third");
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("toMs", () => {
  it("parses durations", () => {
    expect([toMs(250), toMs("500ms"), toMs("30s"), toMs("5m"), toMs("2h"), toMs("1d")]).toEqual([
      250, 500, 30_000, 300_000, 7_200_000, 86_400_000,
    ]);
    // @ts-expect-error not a duration
    expect(() => toMs("soon")).toThrow(/Invalid duration/);
  });
});

describe("webhook", () => {
  it("turns authorized POSTs into items", async () => {
    const source = webhook({ port: 0, path: "/in", secret: "s3cret" });
    const items: Item[] = [];
    const chat = listen(source, { spam: noul("Is this spam?") }, { client: mockJev(() => ({ spam: 0 })), log: silentLogger }).on(
      "judged",
      (e) => {
        items.push(e.item);
      },
    );
    await chat.start();
    const url = source.url as string;
    const post = (body: unknown, token = "s3cret") =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });

    expect((await post({ text: "hello" }, "wrong")).status).toBe(401);
    expect((await post({ nope: true })).status).toBe(400);
    const accepted = await post([{ text: "one", author: "ann" }, "two"]);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ accepted: 2 });
    expect((await fetch(url.replace("/in", "/other"), { method: "POST" })).status).toBe(404);
    // `curl -d` sends JSON as form data; plain text stays text even when it starts with a bracket.
    const untyped = (body: string) => fetch(url, { method: "POST", headers: { authorization: "Bearer s3cret" }, body });
    expect((await untyped('{"text": "three"}')).status).toBe(202);
    expect((await untyped("[ERROR] db down")).status).toBe(202);

    await chat.idle();
    await chat.stop();
    expect(items.map((item) => [item.text, item.author?.name])).toEqual([
      ["one", "ann"],
      ["two", undefined],
      ["three", undefined],
      ["[ERROR] db down", undefined],
    ]);
  });
});
