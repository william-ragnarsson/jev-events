# @jev-events/twitch

Twitch chat for [Jev Events](https://jevevents.dev). Read any public chat, ask Jev about every message,
and moderate your own channel with a bot account.

[Twitch guide](https://jevevents.dev/docs/integrations/twitch) · [Quickstart](https://jevevents.dev/docs/quickstart) ·
[GitHub](https://github.com/william-popmie/jev-events)

```bash
npm i jev-events @jev-events/twitch
```

```ts
import { burst, listen, recipes } from "jev-events";
import { twitch } from "@jev-events/twitch";

const chat = listen(twitch.chat("mychannel", { auth: twitch.auth.fromFile() }), {
  hateful: recipes.chat.hateful,
  spam: recipes.chat.spam,
  streamIssue: recipes.chat.streamIssue,
});

chat
  .on("hateful", { min: 0.9 }, twitch.timeout({ seconds: 600 }))
  .on("spam", { min: 0.85 }, twitch.deleteMessage())
  .on(
    "streamIssue",
    // Three different viewers within 45 seconds, not one viewer three times.
    burst(
      { count: 3, within: "45s", distinctBy: (e) => e.item.author.id },
      () => alertStreamer("Chat reports a problem with the stream"),
    ),
  );

await chat.start(); // dry-run until you pass { dryRun: false } to listen()
```

## Two modes

|  | Anonymous | Signed in |
| --- | --- | --- |
| Setup | None | A bot account that moderates your channel |
| Reads chat through | Twitch's public chat server | EventSub, Twitch's official event API |
| Channels | Any public channel | Any channel |
| Native actions | Dry-run only | Where the bot is a moderator |

`twitch.chat("channel")` without `auth` reads anonymously, which is the fastest way to try questions on
a busy chat. Add `auth` when you're ready to act.

## Sign in a bot

1. **Create a Twitch application** in the [developer console](https://dev.twitch.tv/console/apps) with
   client type **Public** and any redirect URL, such as `http://localhost`. You only need its client ID.
2. **Sign in as the bot.** Use a separate Twitch account, so its actions are clearly labeled in your
   mod log:

   ```bash
   npx jev-events auth twitch --client-id <client id>
   ```

   Open the link it prints and enter the code while signed in as the bot. The tokens are saved to
   `.jev-events/credentials.json`, which only your user can read. Its folder gets a `.gitignore`, and
   refreshed tokens are written back automatically.
3. **Make the bot a moderator.** In your channel's chat, type `/mod <bot name>`.
4. **Pass the sign-in to the source:** `twitch.chat("mychannel", { auth: twitch.auth.fromFile() })`.

On a server, `twitch.auth.fromEnv()` reads `TWITCH_CLIENT_ID`, `TWITCH_ACCESS_TOKEN`, and optionally
`TWITCH_REFRESH_TOKEN` and `TWITCH_CLIENT_SECRET`. If you store tokens yourself,
`twitch.auth.withTokens(tokens, onRefresh)` hands you rotated tokens to save.

## Actions

| Action | What it does | Scope |
| --- | --- | --- |
| `twitch.timeout({ seconds?, reason? })` | Times the chatter out, 600 seconds by default | `moderator:manage:banned_users` |
| `twitch.ban({ reason? })` | Bans the chatter. Prefer a timeout unless you're sure | `moderator:manage:banned_users` |
| `twitch.deleteMessage()` | Deletes the message | `moderator:manage:chat_messages` |
| `twitch.warn({ reason? })` | Sends a warning the chatter must acknowledge before chatting again | `moderator:manage:warnings` |
| `twitch.reply(text)` | Replies to the message in chat, as the bot | `user:write:chat` |
| `twitch.say(text)` | Says something in chat, as the bot | `user:write:chat` |
| `twitch.clip()` | Clips the live stream. Pair it with `burst()` so a hype moment makes one clip, not fifty | `clips:edit` |

Reading chat through EventSub needs `user:read:chat`. `jev-events auth twitch` asks for all of these;
pass `--scopes` to ask for fewer. `reason` and `text` can be strings or functions of the event.

Native actions never run on the broadcaster, moderators, VIPs or Twitch staff, and arming a listener
whose source can't act (an anonymous chat) fails at `start()` instead of silently doing nothing.

## Chat items

Handlers receive a `TwitchChatItem`: `text` (with emotes as their names), `author` (`id`, `login`,
`name` and `roles`), `channel`, `firstMessage`, and `reply` and `bits` when present. Jev sees the text,
the author's name and roles, `firstMessage` and the reply, plus the three messages before it.

`!commands` and well-known bots such as Nightbot and StreamElements are skipped before judging, so they
cost nothing. Change this with the `ignore` option. Messages that waited more than 10 seconds for a
request slot are dropped instead of acted on late.

## License

MIT. Jev Events is a community project built on TypeSafe's Jev. It is not affiliated with or endorsed by
TypeSafe or Twitch.
