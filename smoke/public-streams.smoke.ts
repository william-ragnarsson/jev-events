import { afterEach, describe, expect, it } from "vitest";

import { monitor, noul, silentLogger } from "jev-events";
import { bluesky, twitchChat, type BlueskyPostItem, type TwitchChatItem } from "jev-events/public";
import { mockJev } from "jev-events/testing";

import { listFromEnv, waitFor } from "./helpers.js";

// The public sources against the real services: Bluesky's Jetstream, and Twitch chat read without an
// account. Jev is mocked, so this needs no keys and costs nothing.

const question = noul("Is this worth a look?");
const client = mockJev(() => ({ question: 0.1 }));

// Big channels that are often live.
const TWITCH_CHANNELS = listFromEnv("SMOKE_TWITCH_CHANNELS", ["kaicenat", "jynxzi", "caseoh_", "xqc", "summit1g", "tarik", "lirik", "shroud"]);

const running: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((each) => each.stop()));
});

describe("bluesky (real Jetstream)", () => {
  it("delivers new posts in the languages you ask for", async () => {
    const posts: BlueskyPostItem[] = [];
    const firehose = monitor({ source: bluesky({ langs: ["en"] }), questions: { question }, client, log: silentLogger }).on(
      "judged",
      (event) => void posts.push(event.item),
    );
    running.push(firehose);

    await firehose.start();
    await waitFor(() => posts.length >= 5, 30_000, "5 English posts from Bluesky");

    for (const post of posts.slice(0, 5)) {
      expect(post.did).toMatch(/^did:(plc|web):/);
      expect(post.text.trim()).not.toBe("");
      expect(post.langs).toContain("en");
      expect(post.uri).toBe(`at://${post.did}/app.bsky.feed.post/${post.rkey}`);
      expect(post.url).toBe(`https://bsky.app/profile/${post.did}/post/${post.rkey}`);
      expect(Number.isNaN(post.at.getTime())).toBe(false);
    }
    expect(firehose.stats().errors).toBe(0);
  });
});

describe("twitch chat, anonymous (real Twitch)", () => {
  it("joins channels without an account and reads live chat", async () => {
    const messages: TwitchChatItem[] = [];
    const monitors = TWITCH_CHANNELS.map((channel) =>
      monitor({ source: twitchChat(channel), questions: { question }, client, log: silentLogger }).on(
        "judged",
        (event) => void messages.push(event.item),
      ),
    );
    running.push(...monitors);

    // Joining works whether or not a channel is live; only a banned or renamed channel fails.
    const joins = await Promise.allSettled(monitors.map((each) => each.start()));
    const failed = joins.flatMap((join, index) => (join.status === "rejected" ? [TWITCH_CHANNELS[index]] : []));
    if (failed.length > 0) console.warn(`Couldn't join: ${failed.join(", ")}`);
    expect(failed.length).toBeLessThan(TWITCH_CHANNELS.length);

    await waitFor(
      () => messages.length > 0,
      90_000,
      `a chat message in ${TWITCH_CHANNELS.join(", ")}. If none of them is live, set SMOKE_TWITCH_CHANNELS to one that is`,
    );
    const [message] = messages as [TwitchChatItem];
    expect(TWITCH_CHANNELS).toContain(message.channel);
    expect(message.channelId).toMatch(/^\d+$/);
    expect(message.author.id).toMatch(/^\d+$/);
    expect(message.author.login).toMatch(/^\w+$/);
    expect(message.text.trim()).not.toBe("");
    expect(Date.now() - message.at.getTime()).toBeLessThan(60_000);
  });
});
