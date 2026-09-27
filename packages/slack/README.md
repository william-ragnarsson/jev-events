# @jev-events/slack

Slack for [Jev Events](https://jevevents.dev). Jev reads each new message in the channels and direct
messages your Slack app is in and answers your questions about it; your handlers reply in the thread,
react or post an alert. It works in your own workspace, or in your users' workspaces once they add
your app.

[Slack guide](https://jevevents.dev/docs/integrations/slack) · [Quickstart](https://jevevents.dev/docs/quickstart) ·
[GitHub](https://github.com/william-popmie/jev-events)

```bash
npm i jev-events @jev-events/slack
```

## Try it on your own workspace

```bash
npx jev-events auth slack    # create the app and connect it, once (about 2 minutes)
npx jev-events watch slack   # the latest messages, judged, then new ones as they're posted
```

The first time, `auth slack` prints a link that creates the Slack app with everything filled in,
then asks for its two tokens and checks them. Invite the app to each channel it should read: open
the channel in Slack and type `/invite @jev_events`.

## In code

```ts
import { monitor, recipes } from "jev-events";
import { slack } from "@jev-events/slack";

const team = monitor({
  source: slack.messages(),
  questions: { urgent: recipes.team.urgent, needsAnswer: recipes.team.needsAnswer },
})
  // Outages and blockers, wherever they're mentioned, land in one channel.
  .on("urgent", { min: 0.9 }, slack.post("#incidents"))
  // Messages waiting on an answer get a reaction, so they're easy to spot.
  .on("needsAnswer", { min: 0.8 }, slack.react("eyes"));

// Reads the workspace `npx jev-events auth slack` saved, over Socket Mode.
await team.start();
```

Actions are dry-run until you pass `dryRun: false` to `monitor()`: they log what they would do and
change nothing.

## For your users

Register your Slack app with a runtime, mount its handler, and send people to `/connect/slack`:

```ts
// lib/jev.ts
import { postgresStore, runtime } from "jev-events";
import { slack } from "@jev-events/slack";

export const jev = runtime({
  monitors: [team],
  store: postgresStore(pool),
  apps: [slack.app()], // SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET
  signIn: { user: (request) => yourUserId(request) },
});

// app/api/jev/[...path]/route.ts
export const GET = jev.handle;
export const POST = jev.handle;
```

In your Slack app's settings:

1. Under **OAuth & Permissions → Redirect URLs**, add `https://<your site>/api/jev/callback/slack`.
2. Under **Event Subscriptions**, turn events on and set the Request URL to
   `https://<your site>/api/jev/webhook/slack`. Slack checks it right away, so deploy first.
3. Under **Manage Distribution**, turn on public distribution so other workspaces can add the app.
4. Leave token rotation off: the saved bot token has to keep working.

To start from an app with all of this filled in, open the link `manifestUrl()` makes:

```ts
import { manifestUrl } from "@jev-events/slack";

manifestUrl({
  name: "Acme Triage",
  requestUrl: "https://example.com/api/jev/webhook/slack",
  redirectUrls: ["https://example.com/api/jev/callback/slack"],
});
```

`manifest()` gives the same manifest as an object, to paste under **Create New App → From a manifest**.

New messages then arrive at `/webhook/slack`, signed with your signing secret. A message that fails
for a reason that may pass, such as Slack being down, answers an error so Slack sends it again; a
workspace that removed the app or lacks a scope answers OK, is reported as an error event and is
marked `needs-sign-in` when it has to be added again. Slack tries each message three times over
about five minutes; what's posted during a longer outage isn't sent again.

## Sign-in on your machine or server

`npx jev-events auth slack` walks you through creating your own Slack app the first time (four
steps, about two minutes), checks its two tokens and saves the workspace to `.jev-events/store.json`,
which only your user can read and git ignores. Set `JEV_EVENTS_KEY` to encrypt the tokens in it.

That app uses Socket Mode: with its app-level token (`xapp-…` with `connections:write`), new messages
come over a WebSocket, so nothing needs a public URL. A runtime can do the same for every workspace
that added your app, over one connection: pass `slack.app({ appToken })` or set `SLACK_APP_TOKEN`.

On a server that watches one workspace of your own, `slack.fromEnv()` builds the connection from
`SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`:

```ts
await team.start({ connections: [slack.fromEnv()] });
```

## Source

| Source | Emits |
| --- | --- |
| `slack.messages({ channels?, backfill?, includeBots? })` | Each new message in the channels, private channels and DMs the app is in, or only in `channels` (by name or ID) |

`backfill: 5` also emits the 5 latest messages when starting. Joins, edits, the app's own posts and
other bots (unless `includeBots`) are skipped before judging, so they cost nothing.

## Actions

| Action | What it does |
| --- | --- |
| `slack.reply(text, { broadcast? })` | Replies in the message's thread, or straight into a DM |
| `slack.react(emoji)` | Adds a reaction, such as `slack.react("eyes")` |
| `slack.post(channel, text?)` | Posts in another channel, by default with what fired, the message and a link |

`text` can be a function of what fired, such as ``(e) => `<@${e.item.author.id}> on it` ``. When the
app isn't in a channel or lacks a scope, the error says what to type or click to fix it.

## License

MIT. Jev Events is a community project built on TypeSafe's Jev. It is not affiliated with or endorsed by
TypeSafe or Slack.
