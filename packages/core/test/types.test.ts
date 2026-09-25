import { describe, expectTypeOf, it } from "vitest";

import {
  burst,
  choice,
  defineAction,
  listen,
  noul,
  score,
  type Item,
  type OutcomeEventName,
  type Source,
  type TriggeredEvent,
} from "../src/index.js";
import { mockJev } from "../src/testing.js";

interface ChatItem extends Item {
  channel: string;
}

const twitchLike: Source<ChatItem, "twitch"> = { id: "twitch:chat:x", platform: "twitch", start() {} };
const questions = {
  kind: choice("What is this?", { question: null, hateful: null, other: null }),
  hateful: noul("Is this hateful?"),
  severity: score("How severe?", ["none", "mild", "severe"]),
};

describe("types", () => {
  it("derives outcome event names from the questions", () => {
    expectTypeOf<OutcomeEventName<typeof questions>>().toEqualTypeOf<
      "kind:question" | "kind:hateful" | "kind:other" | "hateful" | "severity"
    >();
  });

  it("types handler payloads from the source and the questions", () => {
    const chat = listen(twitchLike, questions, { client: mockJev(() => ({})) });
    chat.on("kind:question", (e) => {
      expectTypeOf(e.item).toEqualTypeOf<ChatItem>();
      expectTypeOf(e.item.channel).toBeString();
      expectTypeOf(e.answers.kind.choice).toEqualTypeOf<"question" | "hateful" | "other">();
      expectTypeOf(e.answers.hateful.noul).toBeNumber();
      expectTypeOf(e.answers.severity.score).toBeNumber();
    });
    chat.on("judged", (e) => {
      expectTypeOf(e.answers.kind.probabilities.hateful).toBeNumber();
    });
    chat.on("dropped", (e) => {
      expectTypeOf(e.reason).toEqualTypeOf<"filtered" | "stale" | "overflow" | "budget" | "stopped">();
    });
  });

  it("accepts the right policy for each kind of question", () => {
    const chat = listen(twitchLike, questions, { client: mockJev(() => ({})) });
    chat.on("kind:hateful", { min: 0.8, review: 0.5 }, () => {});
    chat.on("severity", { atLeast: 1.5 }, () => {});
    // These also throw at runtime; only their types are under test here.
    const invalid = () => {
      // @ts-expect-error scores take atLeast, not min
      chat.on("severity", { min: 0.5 }, () => {});
      // @ts-expect-error probabilities take min, not atLeast
      chat.on("hateful", { atLeast: 1 }, () => {});
      // @ts-expect-error unknown event
      chat.on("kind:spam", () => {});
    };
    expectTypeOf(invalid).toBeFunction();
  });

  it("only accepts native actions for the source's platform", () => {
    const chat = listen(twitchLike, questions, { client: mockJev(() => ({})) });
    const timeout = defineAction({ platform: "twitch", name: "twitch.timeout", describe: () => "", run: async () => {} });
    const anywhere = defineAction({ platform: "*", name: "notify", describe: () => "", run: async () => {} });
    const discordDelete = defineAction({ platform: "discord", name: "discord.delete", describe: () => "", run: async () => {} });

    chat.on("hateful", timeout);
    chat.on("hateful", anywhere);
    // @ts-expect-error a Discord action can't run on a Twitch stream
    chat.on("hateful", discordDelete);
  });

  it("infers burst events from where the handler is used", () => {
    const chat = listen(twitchLike, questions, { client: mockJev(() => ({})) });
    chat.on(
      "hateful",
      burst({ count: 3, within: "30s", distinctBy: (e) => e.item.author?.id }, (b) => {
        expectTypeOf(b.last).toEqualTypeOf<TriggeredEvent<ChatItem, typeof questions>>();
      }),
    );
  });
});
