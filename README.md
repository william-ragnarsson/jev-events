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

Jev Events reads the inboxes, calendars, Slack workspaces and chats your users connect, asks
[Jev](https://docs.typesafe.ai) your questions about each new email, invite or message, and runs your
code on the answers. It's a library: sign-in, polling, webhooks and storage all run inside your own
app.

## How it works

A **monitor** puts three things together:

1. **A source**: what to read, such as `google.calendar.invites()`, `slack.messages()` or
   `twitch.chat()`.
2. **Questions**: what Jev answers about every item. `choice` picks a label, `noul` gives the
   probability of yes, and `score` places the item on your scale.
3. **Handlers**: what happens on an answer. Your own function, or a built-in action such as
   accepting the invite.

```ts
import { choice, monitor } from "jev-events";
import { google } from "@jev-events/google";

export const invites = monitor({
  source: google.calendar.invites(),
  profile: (connection) => profileOf(connection.userId),
  questions: {
    importance: choice("How important is this meeting to this person?", {
      critical: "They should be there",
      useful: "Worth going if they're free",
      skip: null,
    }),
  },
});

invites.on("importance:critical", { min: 0.85, review: 0.6 },
  google.calendar.respond("accepted"));
invites.on("importance:critical", { min: 0.85 },
  (e) => notify(e.connection, e.item));
invites.on("review", (e) => askUser(e.connection, e));

// Runs for every connected user. Monitors start in dry-run,
// where native actions only report what they would do.
```

- **Typed events.** Event names come from your questions. `"importance:critical"` exists because you
  asked it, and a typo such as `"importance:critcal"` is a compile error.
- **One monitor, every user.** Each connection, such as one user's Google account, has its own
  cursor, budget and profile. Sign-in, token refresh and storage are built in.
- **Safe by default.** Native actions only report what they would do until you pass `dryRun: false`.
  They skip protected people, such as colleagues, people you've emailed and a channel's moderators,
  and they never permanently delete anything.
- **Cheap enough for every message.** Jev input costs $0.042 per million tokens and output is free.
  Daily budgets, rate limits and a queue that drops stale items keep the bill predictable.
- **Official APIs only.** Each integration uses the platform's API with your own app. Nothing is
  scraped.

## Try it in 30 seconds

Judge live posts in your terminal. You need a
[TypeSafe API key](https://docs.typesafe.ai/introduction/quickstart) and no other account. The first run
asks for the key and saves it to `.env`.

```bash
npx jev-events watch bluesky            # live Bluesky posts
npx jev-events watch twitch:<channel>   # any live Twitch chat
```

Then your own accounts. Install the integrations, and each `auth` runs once and walks you through
the setup:

```bash
npm i jev-events @jev-events/google @jev-events/slack @jev-events/twitch
npx jev-events auth google && npx jev-events watch gmail   # or: watch calendar
npx jev-events auth slack && npx jev-events watch slack
npx jev-events auth twitch && npx jev-events watch twitch
```

## Set it up with your coding agent

The [docs](https://jevevents.dev/docs) open with a prompt for Claude Code, Cursor or any other coding
agent. Pick what to watch and what should happen, paste the prompt, and the agent writes the code and
tells you each step that needs you. Each integration's page also has a builder that writes the code
for what you pick.

## Run it for your users

Give the monitor to a runtime, with a store and your OAuth app, and mount its handler:

```ts
// lib/jev.ts
import { postgresStore, runtime } from "jev-events";
import { google } from "@jev-events/google";

import { invites } from "./invites";

export const jev = runtime({
  monitors: [invites],
  store: postgresStore(pool), // tokens are encrypted with JEV_EVENTS_KEY
  apps: [google.app()], // GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
  signIn: { user: (request) => userIdOf(request) }, // who's signed in to your product
});
```

```ts
// app/api/jev/[...path]/route.ts
import { jev } from "@/lib/jev";

export const GET = jev.handle;
export const POST = jev.handle;
```

1. Send signed-in users to `/api/jev/connect/google`. They approve on Google and come back
   connected.
2. Have a cron job call `/api/jev/cron` every few minutes with `Authorization: Bearer <CRON_SECRET>`.
   Each call checks every connection that is due for new mail and invites.
3. Slack posts new messages to `/api/jev/webhook/slack`. Twitch chat needs a connection that stays
   open, so run `await jev.start()` in a long-running worker for it.

`npx jev-events key` prints a new `JEV_EVENTS_KEY`.

## Install

```bash
npm i jev-events @jev-events/google   # or @jev-events/slack, @jev-events/twitch
```

Jev Events needs Node.js 22 or newer. Start with the [quickstart](https://jevevents.dev/docs/quickstart).

## Packages

| Package | What it does | Status |
| --- | --- | --- |
| [`jev-events`](packages/core) | The engine: `monitor()`, `runtime()`, stores, typed events, thresholds, dry-run, budgets, rate limits, recipes, `from()`, `webhook()`, `burst()`, `logTo()`, a test client and the `jev-events` CLI | Available |
| [`@jev-events/google`](packages/google) | Gmail and Google Calendar, plus trash, archive, label, star, mark read, draft reply, and accept, decline and maybe | Available |
| [`@jev-events/slack`](packages/slack) | Slack channels and DMs, plus reply, react and post | Available |
| [`@jev-events/twitch`](packages/twitch) | Twitch chat, plus timeout, ban, delete, warn, reply, say and clip | Available |
| `@jev-events/microsoft` | Outlook mail, Outlook calendar and Teams | In development |
| `@jev-events/discord` | Discord messages and moderation | In development |
| `@jev-events/github` | GitHub issues, pull requests and comments | In development |
| `@jev-events/linear` | Linear issues and comments | In development |
| `@jev-events/notion` | Notion pages and comments | In development |

Google Drive and YouTube are coming to `@jev-events/google`. Anything else with text works today
through `from(asyncIterable)` or `webhook()`. See
[Anything else](https://jevevents.dev/docs/integrations/custom).

## This repository

| Path | What's there |
| --- | --- |
| [`packages/core`](packages/core) | `jev-events` |
| [`packages/google`](packages/google) | `@jev-events/google` |
| [`packages/slack`](packages/slack) | `@jev-events/slack` |
| [`packages/twitch`](packages/twitch) | `@jev-events/twitch` |
| [`examples/twitch-moderator`](examples/twitch-moderator) | A complete Twitch moderator in about 50 lines |
| [`evals`](evals) | The labeled dataset and the benchmark runner behind every published accuracy number |
| [`apps/web`](apps/web) | [jevevents.dev](https://jevevents.dev): the landing page and the docs |
| [`scripts`](scripts) | Site data generation |
| [`smoke`](smoke) | Opt-in tests of each integration against the real service |
| [`CONTEXT.md`](CONTEXT.md), [`docs/adr`](docs/adr) | The words the code and docs use, and the decisions behind the design |

### Develop

```bash
npm install
npm test            # unit, type and docs-snippet tests; integrations against local fakes
npm run test:smoke  # integrations against the real services, see smoke/README.md
npm run typecheck
npm run build       # every package into dist/
npm run cli -- watch bluesky   # the jev-events CLI from source, no build needed
```

Run the site, with the docs, at http://localhost:3000:

```bash
npm run dev -w @jev-events/web
```

The site reads generated data from `apps/web/generated`. After changing a snippet or a recipe, run
`npm run site:data`. A test fails when the generated files are stale.

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
TypeSafe. Twitch, YouTube, Discord, Gmail, Google Calendar, Google Drive, Outlook, Microsoft Teams,
Slack, GitHub, Linear and Notion are trademarks of their respective owners.
