# @jev-events/twitch

Twitch chat for [Jev Events](https://jevevents.dev). Jev reads each new message in a channel's chat
and answers your questions about it; your handlers delete the message, time the chatter out, reply
or clip the stream. It works on your own channel, or on your users' channels once they connect their
Twitch accounts on your site.

[Twitch guide](https://jevevents.dev/docs/integrations/twitch) · [Quickstart](https://jevevents.dev/docs/quickstart) ·
[GitHub](https://github.com/william-popmie/jev-events)

```bash
npm i jev-events @jev-events/twitch
```

## Try it on your own channel

```bash
npx jev-events auth twitch    # create the app and sign in, once (about 2 minutes)
npx jev-events watch twitch   # your channel's chat, judged as each message comes in
```

The first time, `auth twitch` lists the three steps to create your Twitch app and asks for its
Client ID. Then it opens Twitch, where you check the code it shows and click Authorize.

To try it on someone else's channel without signing in: `npx jev-events watch twitch:<channel>`.

## In code

```ts
import { burst, monitor, recipes } from "jev-events";
import { twitch } from "@jev-events/twitch";

const mods = monitor({
  source: twitch.chat(),
  questions: { hateful: recipes.chat.hateful, spam: recipes.chat.spam, streamIssue: recipes.chat.streamIssue },
})
  .on("hateful", { min: 0.9 }, twitch.timeout({ seconds: 600 }))
  .on("spam", { min: 0.85 }, twitch.deleteMessage())
  .on(
    "streamIssue",
    // Three different viewers within 45 seconds, not one viewer three times.
    burst({ count: 3, within: "45s", distinctBy: (e) => e.item.author.id }, ({ last }) => {
      console.warn(`Chat says the stream has a problem: "${last.item.text}"`);
    }),
  );

// Reads the channel of the account `npx jev-events auth twitch` saved, over EventSub.
await mods.start();
```

Actions are dry-run until you pass `dryRun: false` to `monitor()`: they log what they would do and
change nothing.

`twitch.chat("somechannel")` reads another channel as your account. To act there, the account has to
be a moderator: the broadcaster types `/mod <your account>` in chat. A bot account of its own keeps
its actions apart from yours in the mod log.

## For your users

Register your Twitch app with a runtime, mount its handler, and send streamers to `/connect/twitch`:

```ts
// lib/jev.ts
import { postgresStore, runtime } from "jev-events";
import { twitch } from "@jev-events/twitch";

export const jev = runtime({
  monitors: [mods],
  store: postgresStore(pool),
  apps: [twitch.app()], // TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET
  signIn: { user: (request) => yourUserId(request) },
});

// app/api/jev/[...path]/route.ts
export const GET = jev.handle;
export const POST = jev.handle;
```

In your app's settings at [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps):

1. Set the client type to **Confidential**. Signing people in on your site needs the client secret.
2. Under **OAuth Redirect URLs**, add `https://<your site>/api/jev/callback/twitch`.

With `twitch.chat()` and no channel, each streamer who connects has their own channel read, as
their own account. Chat comes over a WebSocket that stays open, so read it in a long-running worker
rather than a serverless function:

```ts
// worker.ts
import { jev } from "./lib/jev";

await jev.start(); // every connected channel, and each new one as soon as it's connected
```

## Sign-in on your machine or server

`npx jev-events auth twitch` signs in with a code you approve on Twitch, and saves the connection to
`.jev-events/store.json`, which only your user can read and git ignores. Set `JEV_EVENTS_KEY` to
encrypt the tokens in it. It asks for all the scopes below; pass `--scopes` to ask for fewer,
`--client-id` to skip the question, and `--client-secret` if your app is Confidential.

Twitch accepts each refresh token only once, so renewed tokens are saved back to the store they came
from. On a server that reads one account of your own, `twitch.fromEnv()` builds the connection from
`TWITCH_CLIENT_ID` and `TWITCH_ACCESS_TOKEN`, plus `TWITCH_REFRESH_TOKEN` and `TWITCH_CLIENT_SECRET`
when you have them:

```ts
await mods.start({ connections: [twitch.fromEnv()] });
```

Tokens renewed there can't be written back to your environment. That works for a Confidential app's
refresh token, which Twitch accepts again; a Public app's is spent after the first renewal, so use
the saved sign-in or a runtime with a store instead.

## Source

| Source | Emits |
| --- | --- |
| `twitch.chat({ channel?, ignore? })` | Each new chat message in the account's own channel, or in `channel` |

`twitch.chat("somechannel")` is short for `twitch.chat({ channel: "somechannel" })`. Reading needs
`user:read:chat`. Twitch allows 3 chat connections per account and app, so one account can be read
by at most 3 monitors or `jev-events watch` runs at a time.

## Actions

| Action | What it does | Scope |
| --- | --- | --- |
| `twitch.timeout({ seconds?, reason? })` | Times the chatter out, 600 seconds by default | `moderator:manage:banned_users` |
| `twitch.ban({ reason? })` | Bans the chatter. Prefer a timeout unless you're sure | `moderator:manage:banned_users` |
| `twitch.deleteMessage()` | Deletes the message | `moderator:manage:chat_messages` |
| `twitch.warn({ reason? })` | Sends a warning the chatter must acknowledge before chatting again | `moderator:manage:warnings` |
| `twitch.reply(text)` | Replies to the message in chat | `user:write:chat` |
| `twitch.say(text)` | Says something in chat | `user:write:chat` |
| `twitch.clip()` | Clips the live stream. Pair it with `burst()` so a hype moment makes one clip, not fifty | `clips:edit` |

`reason` and `text` can be strings or functions of what fired, such as
``(e) => `@${e.item.author.name} thanks!` ``. When the account isn't a moderator or hasn't allowed a
scope, the error says so and how to fix it.

Actions never run on the broadcaster, moderators, VIPs or Twitch staff: those messages are marked
`protected`.

## Chat items

Handlers receive a `TwitchChatItem`: `text` (with emotes as their names), `author` (`id`, `login`,
`name` and `roles`), `channel`, `firstMessage`, and `reply` and `bits` when present. Jev sees the
text, the author's name and roles, `firstMessage` and the reply, plus the three messages before it.

`!commands` and well-known bots such as Nightbot and StreamElements are skipped before judging, so
they cost nothing. Change this with the `ignore` option. Messages that waited more than 10 seconds
to be judged are dropped instead of acted on late.

## License

MIT. Jev Events is a community project built on TypeSafe's Jev. It is not affiliated with or endorsed by
TypeSafe or Twitch.
