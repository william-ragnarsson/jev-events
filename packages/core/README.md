# jev-events

**Turn any stream into typed, semantic events.**

Jev Events reads a stream, asks [TypeSafe's Jev](https://docs.typesafe.ai) your questions about every
item as it arrives, and runs your handlers on the answers: a built-in platform action, such as
archiving an email or timing out a Twitch chatter, or your own code.

[Website](https://jevevents.dev) · [Quickstart](https://jevevents.dev/docs/quickstart) ·
[Docs](https://jevevents.dev/docs) · [Recipes](https://jevevents.dev/docs/recipes) ·
[GitHub](https://github.com/william-popmie/jev-events)

```bash
npm i jev-events
```

Jev Events needs Node.js 22 or newer and a
[TypeSafe API key](https://docs.typesafe.ai/introduction/quickstart) in `TYPESAFE_API_KEY`.

## Example

Reading a public Twitch chat needs no Twitch account. Put any live channel in place of
`some_live_channel`:

```ts
import { monitor, recipes } from "jev-events";
import { twitchChat } from "jev-events/public";

const chat = monitor({
  source: twitchChat("some_live_channel"),
  questions: { kind: recipes.chat.kind, hateful: recipes.chat.hateful },
})
  .on("kind:question", (e) =>
    console.log(`[question] ${e.item.author.name}: ${e.item.text}`),
  )
  .on("hateful", { min: 0.9 }, (e) =>
    console.log(`[hateful] ${e.item.author.name} (${e.trigger.probability})`),
  );

await chat.start();
```

A monitor puts three things together: a **source** that reads new items, **questions** Jev answers
about each one, and **handlers** that run on the answers. The integrations add sources and native
actions for each platform, such as `google.gmail.inbox()` and `google.gmail.archive()` in
[`@jev-events/google`](https://www.npmjs.com/package/@jev-events/google).

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
chat.on("hateful", { min: 0.9, review: 0.6 }, handler); // 0.6–0.9 emits "review" instead
chat.on("toxicity", { atLeast: 2 }, handler);
```

Several questions about the same item go to Jev in one request. Special events cover everything else:
`judged` (every item), `review`, `action`, `dropped` and `error`.

## Actions

A handler is either your own function or a native action.

- **Your functions** run whenever the outcome fires. They receive the item, every answer, the
  connection it came from and the trigger that fired.
- **Native actions**, such as `twitch.timeout()` or `google.gmail.archive()`, are dry-run until you
  pass `dryRun: false` to `monitor()`, and never run on protected people, such as colleagues or a
  channel's moderators. Wrap your own side effects in `defineAction()` to get the same dry-run gate
  and protections.
- **`burst()`** counts across items: "three different viewers report no sound within 45 seconds".

## Sources

| Source | From |
| --- | --- |
| `google.gmail.inbox()`, `google.calendar.invites()`, `slack.messages()`, `twitch.chat()` | The integrations: [`@jev-events/google`](https://www.npmjs.com/package/@jev-events/google), [`@jev-events/slack`](https://www.npmjs.com/package/@jev-events/slack), [`@jev-events/twitch`](https://www.npmjs.com/package/@jev-events/twitch) |
| `twitchChat(channel)`, `bluesky()` | `jev-events/public`: public streams that need no sign-in |
| `from(iterable)` | Any iterable or async iterable of strings or items, or of anything else with a `map` function |
| `webhook({ port, secret })` | Anything that can POST JSON or text |
| Your own | A `Source` has `check(ctx)` to poll or `start(ctx)` for a live stream. [Write one](https://jevevents.dev/docs/concepts/sources) in about 30 lines |

## Running it

- **`mods.start()`** runs the monitor in this process until `mods.stop()`. For integrations, it reads
  the accounts `npx jev-events auth <integration>` saved in `.jev-events/`.
- **`mods.run()`** reads once, handles every item, stops and returns the stats. Use it in scripts,
  cron jobs and tests.
- **`runtime({ monitors, store, apps })`** runs monitors for your users, one run per connected
  account. `jev.handle` serves the sign-in, webhook and cron routes of a web app, and `jev.start()`
  runs everything in a long-running worker. See [for your users](https://jevevents.dev/docs/your-users).

| Store | Keeps cursors, budgets and connections |
| --- | --- |
| `fileStore()` | In `.jev-events/store.json`. The default for sign-ins on your own machine |
| `memoryStore()` | In memory, gone on restart. The default for streams without accounts, and for tests |
| `postgresStore(pool)` | In Postgres, shared by every request, cron run and worker. Tokens are encrypted with `JEV_EVENTS_KEY`; `npx jev-events key` prints one |

## Options

`monitor({ source, questions, ...options })` takes:

| Option | Default | What it does |
| --- | --- | --- |
| `id` | the source's id | Names the monitor in stats, logs and saved state. Keep it stable |
| `every` | the source's suggestion, or 1 minute | How often a polling source checks for new items |
| `dryRun` | `true` | Native actions only log what they would do |
| `profile` | | What your product knows about the person behind a connection, shown to Jev |
| `filter` | | Skip items before they are judged or cost anything |
| `protect` | | Extra people that native actions must never touch |
| `context` | from the source | `{ recent, about }`: preceding items and fixed facts shown to Jev |
| `state`, `inspect` | from the source | Build what Jev sees yourself |
| `rate` | 18/s, burst 20, 16 in flight | Stays under Jev's 1,200 requests per minute |
| `maxQueue` | 1000 | Items waiting per connection. The oldest are dropped beyond this |
| `maxLagMs` | from the source (10 s for chat) | Items that waited longer are dropped, not acted on late |
| `cache` | off | Reuse answers for identical text during copy-paste floods |
| `budget` | none | `{ inputTokensPerDay, perConnection }` or a shared `DailyBudget` |
| `client`, `model` | `TYPESAFE_API_KEY`, `jev-latest` | The Jev client and model |
| `log` | `"info"` | A level or your own logger |

`mods.use(logTo("audit.jsonl"))` writes every judgment and action to a JSONL audit log, and
`mods.stats()` reports counts, latency, tokens and estimated spend.

## Recipes

Ready-made questions, scored in the [benchmarks](https://jevevents.dev/docs/benchmarks):
`recipes.chat.kind`, `hateful`, `question`, `streamIssue`, `spam`, `spoiler(game)` and `toxicity`, plus
recipes for comments, email, calendars and team chat. See
[all recipes](https://jevevents.dev/docs/recipes).

## CLI

```bash
npx jev-events watch twitch:<channel>                  # label any public chat
npx jev-events watch twitch:<channel> --only \
  --ask "streamIssue=Is this about the stream's audio or video?"
tail -f app.log | npx jev-events watch stdin --ask "Is this an error a human should look at?"
npx jev-events auth google && npx jev-events watch gmail   # your own inbox
npx jev-events key                                     # a new JEV_EVENTS_KEY
```

See the [CLI reference](https://jevevents.dev/docs/cli).

## Testing

`jev-events/testing` has a fake Jev client, so tests run without a network or an API key:

```ts
import { from, monitor, noul } from "jev-events";
import { mockJev } from "jev-events/testing";

const jev = mockJev(({ state }) => ({
  outage: JSON.stringify(state).includes("ECONNREFUSED") ? 0.96 : 0.03,
}));
const logs = monitor({
  source: from(["GET /health 200", "db: connect ECONNREFUSED 10.0.0.5:5432"]),
  questions: { outage: noul("Does this log line describe a failure a human should look at?") },
  client: jev,
});
const stats = await logs.run(); // judges both lines, then stops
```

## Costs

Jev input costs $0.042 per million tokens, and output is free
([TypeSafe pricing](https://docs.typesafe.ai/models)). You pay for the state and your questions on every
item, so context is the main lever. `budget` puts a hard cap on a day's spend.

## License

MIT. Jev Events is a community project built on TypeSafe's Jev. It is not affiliated with or endorsed by
TypeSafe.
