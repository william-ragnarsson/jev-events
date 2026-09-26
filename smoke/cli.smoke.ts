import { describe, expect, it } from "vitest";

import { fakeJevServer } from "../packages/core/test/fake-jev.js";
import { liveCli } from "../packages/core/test/run-cli.js";
import { waitFor } from "./helpers.js";

// The CLI end to end: real Bluesky posts in, through the real SDK, to a local fake Jev. No keys needed.

describe("jev-events watch (real Bluesky)", () => {
  it("prints a judged line per post", async () => {
    const jev = await fakeJevServer();
    const cli = liveCli(["watch", "bluesky", "--lang", "en", "--json"], { TYPESAFE_API_KEY: "smoke", TYPESAFE_BASE_URL: jev.url });
    try {
      await waitFor(() => cli.lines().length >= 3, 45_000, "3 judged posts from the CLI");
    } finally {
      await cli.stop();
      await jev.close();
    }

    expect(cli.stderr).toBe("");
    for (const line of cli.lines().slice(0, 3)) {
      const post = JSON.parse(line) as { text: string; answers: { topic: { type: string; choice: string } } };
      expect(post.text.trim()).not.toBe("");
      // With no question given, posts get the CLI's default topic question.
      expect(post.answers.topic.type).toBe("choice");
    }
    expect(jev.requests.length).toBeGreaterThanOrEqual(3);
    expect(jev.requests[0]?.body.questions?.topic?.type).toBe("choice");
  });
});
