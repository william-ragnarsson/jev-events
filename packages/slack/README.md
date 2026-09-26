# @jev-events/slack

Slack for [Jev Events](https://jevevents.dev). Ask Jev about every message in the channels and DMs your
Slack app is in, then reply, react or post.

[Slack guide](https://jevevents.dev/docs/integrations/slack) · [Quickstart](https://jevevents.dev/docs/quickstart) ·
[GitHub](https://github.com/william-popmie/jev-events)

```bash
npm i jev-events @jev-events/slack
```

```ts
import { listen, recipes } from "jev-events";
import { slack } from "@jev-events/slack";

// `npx jev-events auth slack` connects your Slack app and saves its tokens.
const team = listen(slack.messages({ auth: slack.auth.fromFile() }), {
  urgent: recipes.team.urgent,
  needsAnswer: recipes.team.needsAnswer,
});

team
  // Outages and blockers, wherever they're mentioned, land in one channel.
  .on("urgent", { min: 0.9 }, slack.post("#incidents"))
  // Messages waiting on an answer get a reaction, so they're easy to spot.
  .on("needsAnswer", { min: 0.8 }, slack.react("eyes"));

await team.start(); // dry-run until you pass { dryRun: false }
```

## Connect a workspace

```bash
npx jev-events auth slack
```

The first time, it prints a link that creates the Slack app with everything filled in, then asks for its
two tokens and checks them. They're saved to `.jev-events/credentials.json`, which only your user can
read. Invite the app to each channel it should read with `/invite @<app>`.

On a server, `slack.auth.fromEnv()` reads `SLACK_BOT_TOKEN`, plus `SLACK_APP_TOKEN` for Socket Mode or
`SLACK_SIGNING_SECRET` for the Events API, where `source.handle(request)` answers Slack's requests.

## Actions

| Action | What it does |
| --- | --- |
| `slack.reply(text, { broadcast? })` | Replies in the message's thread, or straight into a DM |
| `slack.react(emoji)` | Adds a reaction, such as `slack.react("eyes")` |
| `slack.post(channel, text?)` | Posts in another channel, by default with a link to the message |

Joins, edits, the app's own posts and other bots are skipped before judging, so they cost nothing.

## License

MIT. Jev Events is a community project built on TypeSafe's Jev. It is not affiliated with or endorsed by
TypeSafe or Slack.
