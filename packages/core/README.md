# jev-events

**Turn any stream into typed, semantic events.**

Jev Events connects to a stream, asks [TypeSafe's Jev](https://docs.typesafe.ai) a question about every
item as it arrives, and turns the answers into typed events. You handle each event with a built-in
platform action, such as timing out a Twitch chatter, or with your own code.

[Website](https://jevevents.dev) · [Quickstart](https://jevevents.dev/docs/quickstart) ·
[Docs](https://jevevents.dev/docs) · [Recipes](https://jevevents.dev/docs/recipes) ·
[GitHub](https://github.com/william-popmie/jev-events)

```bash
npm i jev-events @jev-events/twitch
export TYPESAFE_API_KEY=...   # https://docs.typesafe.ai/introduction/quickstart
```

Jev Events needs Node.js 22 or newer.

## Example

Reading a public Twitch chat needs no Twitch account:

```ts
import { listen, recipes } from "jev-events";
import { twitch } from "@jev-events/twitch";

const chat = listen(twitch.chat("some_live_channel"), {
  kind: recipes.chat.kind,
  hateful: recipes.chat.hateful,
});

chat.on("kind:question", (e) => {
  console.log(`❓ ${e.item.author.name}: ${e.item.text}`);
});
// Dry-run: this only logs what it would do.
chat.on("hateful", { min: 0.9 }, twitch.timeout({ seconds: 600 }));

await chat.start();
```

```
[jev-events] [dry-run] would timeout viewer_42 for 600s (hateful p=0.97)
```

To act for real, sign in a bot with `npx jev-events auth twitch`, make it a moderator, pass
`{ auth: twitch.auth.fromFile() }` to the source and `{ dryRun: false }` to `listen()`.

## Questions become events

Questions use Jev's three answer types. Their ids and labels become event names, checked by TypeScript.

| Question | Answer | Events |
| --- | --- | --- |
| `choice("…", { question: "…", hype: "…", other: null })` | One label wins | `"kind:question"`, `"kind:hype"`, `"kind:other"` |
| `noul("Does this reveal the ending?")` | The probability of yes | `"spoiler"`, when p ≥ `min` (default 0.5) |
| `score("How toxic is this?", [levels])` | A position on your scale | `"toxicity"`, when the score ≥ `atLeast` |

```ts
chat.on("kind:question", handler); // the label won
chat.on("kind:question", { min: 0.8 }, handler); // …with at least 80%
chat.on("hateful", { min: 0.9, review: 0.6 }, twitch.timeout()); // 0.6–0.9 emits "review" instead
chat.on("toxicity", { atLeast: 2 }, handler);
```

Several questions about the same item go to Jev in one request. Special events cover everything else:
`judged` (every item), `review`, `action`, `dropped` and `error`.

## Actions

A handler is either your own function or a native action.

- **Your functions** run whenever the outcome fires. They receive the item, every answer, and the
  trigger that fired.
- **Native actions**, such as `twitch.timeout()`, are dry-run until you pass `dryRun: false`, and never
  run on protected users (for Twitch: the broadcaster, moderators, VIPs and staff). Wrap your own side
  effects in `defineAction()` to get the same dry-run gate and protections.
- **`burst()`** counts across items: "three different viewers report no sound within 45 seconds".

## Sources

| Source | From |
| --- | --- |
| `twitch.chat(channel)` | [`@jev-events/twitch`](https://www.npmjs.com/package/@jev-events/twitch) |
| `from(iterable)` | Any iterable or async iterable of strings or items, or of anything else with a `map` function |
| `webhook({ port, secret })` | Anything that can POST JSON or text |
| Your own | A `Source` is an object with a `start(ctx)` method. [Write one](https://jevevents.dev/docs/concepts/sources) in about 30 lines |

Discord, YouTube, Gmail and Google Calendar connectors are in development.

## Options

`listen(source, questions, options)` takes:

| Option | Default | What it does |
| --- | --- | --- |
| `dryRun` | `true` | Native actions only log what they would do |
| `filter` | | Skip items before they are judged or cost anything |
| `protect` | | Extra users that native actions must never touch |
| `context` | from the source | `{ recent, about }`: preceding items and static facts shown to Jev |
| `state`, `inspect` | from the source | Build Jev's state yourself |
| `rate` | 18/s, burst 20, 16 in flight | Stays under Jev's 1,200 requests per minute |
| `maxQueue` | 1000 | The oldest waiting items are dropped beyond this |
| `maxLagMs` | from the source (10 s for chat) | Items that waited longer are dropped, not acted on late |
| `cache` | off | Reuse answers for identical text during copy-paste floods |
| `budget` | none | `{ inputTokensPerDay }` or a shared `DailyBudget` |
| `client`, `model` | `TYPESAFE_API_KEY`, `jev-latest` | The Jev client and model |
| `log` | `"info"` | A level or your own logger |

`listener.use(logTo("audit.jsonl"))` writes every judgment and action to a JSONL audit log, and
`listener.stats()` reports counts, latency, tokens and estimated spend.

## Recipes

Ready-made questions, scored in the [benchmarks](https://jevevents.dev/docs/benchmarks):
`recipes.chat.kind`, `hateful`, `question`, `streamIssue`, `spam`, `spoiler(game)` and `toxicity`, plus
recipes for comments, email and calendars. See [all recipes](https://jevevents.dev/docs/recipes).

## CLI

```bash
npx jev-events watch twitch:<channel>                  # label any public chat
npx jev-events watch twitch:<channel> --only \
  --ask "streamIssue=Is this about the stream's audio or video?"
tail -f app.log | npx jev-events watch stdin --ask "Is this an error a human should look at?"
npx jev-events auth twitch --client-id <id>            # sign in a bot
```

See the [CLI reference](https://jevevents.dev/docs/cli).

## Testing

`jev-events/testing` has a fake Jev client, so tests run without a network or an API key:

```ts
import { from, listen, noul } from "jev-events";
import { mockJev } from "jev-events/testing";

const jev = mockJev(({ state }) => ({
  outage: JSON.stringify(state).includes("ECONNREFUSED") ? 0.96 : 0.03,
}));
const logs = listen(
  from(["GET /health 200", "db: connect ECONNREFUSED 10.0.0.5:5432"]),
  { outage: noul("Does this log line describe a failure a human should look at?") },
  { client: jev },
);
const stats = await logs.run(); // judges both lines, then stops
```

## Costs

Jev input costs $0.042 per million tokens, and output is free
([TypeSafe pricing](https://docs.typesafe.ai/models)). You pay for the state and your questions on every
item, so context is the main lever. `budget` puts a hard cap on a day's spend.

## License

MIT. Jev Events is a community project built on TypeSafe's Jev. It is not affiliated with or endorsed by
TypeSafe.
