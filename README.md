<p align="center">
  <a href="https://jevevents.dev"><img src="apps/web/app/icon.svg" width="64" height="64" alt="Jev Events"></a>
</p>

<h1 align="center">Jev Events</h1>

<p align="center">
  <strong>Turn any stream into typed, semantic events.</strong><br>
  An open-source TypeScript library built on TypeSafe's Jev.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/jev-events"><img src="https://img.shields.io/npm/v/jev-events?color=c0f84f&labelColor=0a0a0a" alt="npm version"></a>
  <a href="https://github.com/william-popmie/jev-events/actions/workflows/ci.yml"><img src="https://github.com/william-popmie/jev-events/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-c0f84f?labelColor=0a0a0a" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://jevevents.dev">Website</a> ·
  <a href="https://jevevents.dev/docs/quickstart">Quickstart</a> ·
  <a href="https://jevevents.dev/docs">Docs</a> ·
  <a href="https://jevevents.dev/docs/recipes">Recipes</a> ·
  <a href="https://jevevents.dev/docs/benchmarks">Benchmarks</a>
</p>

---

Jev Events connects to a stream, asks [Jev](https://docs.typesafe.ai) a question about every item as it
arrives, and turns the answers into typed events. You handle each event with a built-in platform action,
such as timing out a Twitch chatter, or with your own code.

```ts
import { choice, listen, recipes } from "jev-events";
import { twitch } from "@jev-events/twitch";

const chat = listen(twitch.chat("mychannel", { auth: twitch.auth.fromFile() }), {
  kind: choice("What is this chat message doing?", {
    question: "Asks the streamer something",
    spoiler: "Reveals story or boss details",
    other: null,
  }),
  hateful: recipes.chat.hateful,
});

chat.on("hateful", { min: 0.9, review: 0.6 }, twitch.timeout({ seconds: 600 }));
chat.on("kind:spoiler", twitch.deleteMessage());
chat.on("kind:question", (e) => overlay.push(e.item.text)); // your own code
chat.on("review", (e) => modQueue.add(e)); // unsure? a human decides

await chat.start(); // native actions are dry-run until { dryRun: false }
```

- **Typed events.** Event names come from your questions. `"kind:question"` exists because you asked
  it, and a typo such as `"kind:spoilr"` is a compile error.
- **Safe by default.** Native actions only log what they would do until you pass `dryRun: false`, and
  they never touch the broadcaster, moderators or VIPs.
- **Cheap enough for every message.** Jev input costs $0.042 per million tokens and output is free.
  Daily budgets, rate limits and a queue that drops stale items keep the bill predictable.
- **Official APIs only.** Twitch chat comes from EventSub or Twitch's public chat server. Nothing is
  scraped.

## Try it in 30 seconds

Label any public Twitch chat in your terminal. You need a
[TypeSafe API key](https://docs.typesafe.ai/introduction/quickstart), and no Twitch account.

```bash
export TYPESAFE_API_KEY=...
npx jev-events watch twitch:<channel>
```

## Install

```bash
npm i jev-events @jev-events/twitch
```

Jev Events needs Node.js 22 or newer. Start with the [quickstart](https://jevevents.dev/docs/quickstart).

## Packages

| Package | What it does | Status |
| --- | --- | --- |
| [`jev-events`](packages/core) | The engine: `listen()`, typed events, thresholds, dry-run, budgets, rate limits, recipes, `from()`, `webhook()`, `burst()`, `logTo()`, a test client and the `jev-events` CLI | Available |
| [`@jev-events/twitch`](packages/twitch) | Twitch chat, plus timeout, ban, delete, warn, reply, say and clip | Available |
| `@jev-events/discord` | Discord messages and moderation | In development |
| `@jev-events/youtube` | YouTube live chat and comments | In development |
| `@jev-events/google` | Gmail and Google Calendar | In development |

Anything else with text works today through `from(asyncIterable)` or `webhook()`. See
[Anything else](https://jevevents.dev/docs/integrations/custom).

## This repository

| Path | What's there |
| --- | --- |
| [`packages/core`](packages/core) | `jev-events` |
| [`packages/twitch`](packages/twitch) | `@jev-events/twitch` |
| [`examples/twitch-moderator`](examples/twitch-moderator) | A complete Twitch moderator in about 40 lines |
| [`evals`](evals) | The labeled dataset and the benchmark runner behind every published accuracy number |
| [`apps/web`](apps/web) | [jevevents.dev](https://jevevents.dev): the landing page and the docs |
| [`apps/live-relay`](apps/live-relay) | The service behind the live feed on the landing page |
| [`scripts`](scripts) | Site data generation and a local stand-in for Jev |

### Develop

```bash
npm install
npm test            # unit, type and docs-snippet tests
npm run typecheck
npm run build       # packages/core and packages/twitch into dist/
```

Run the site with a live feed locally, with no API key. The labels come from a keyword stand-in for Jev
and mean nothing:

```bash
npm run mock-jev    # stand-in for Jev on :8799
TYPESAFE_API_KEY=mock TYPESAFE_BASE_URL=http://127.0.0.1:8799 LIVE_CHANNELS=<channel> \
  npm start -w @jev-events/live-relay
NEXT_PUBLIC_RELAY_URL=http://localhost:8790 npm run dev -w @jev-events/web
```

The site reads generated data from `apps/web/generated`. After changing a snippet, a recipe or the
relay source, run `npm run site:data`. A test fails when the generated files are stale.

### Benchmarks

```bash
export TYPESAFE_API_KEY=...
npm run eval -- --mode all
npm run eval:report
```

The [evals README](evals/README.md) explains the dataset, the modes and every metric.

### Releases

Versions and changelogs are managed with [Changesets](https://github.com/changesets/changesets). Run
`npm run changeset` in a pull request that changes a package. On `main`, the release workflow opens a
version pull request and publishes to npm when it merges.

## License

[MIT](LICENSE).

Jev Events is a community project built on TypeSafe's Jev. It is not affiliated with or endorsed by
TypeSafe. Twitch, YouTube, Discord, Gmail and Google Calendar are trademarks of their respective owners.
