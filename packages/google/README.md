# @jev-events/google

Gmail and Google Calendar for [Jev Events](https://jevevents.dev). Jev reads each new email or
calendar invite and answers your questions about it; your handlers archive, label, trash or answer
the invite. It works on your own account, or on your users' accounts once they connect them.

[Gmail guide](https://jevevents.dev/docs/integrations/gmail) · [Calendar guide](https://jevevents.dev/docs/integrations/google-calendar) ·
[Quickstart](https://jevevents.dev/docs/quickstart) · [GitHub](https://github.com/william-popmie/jev-events)

```bash
npm i jev-events @jev-events/google
```

## Try it on your own inbox

```bash
npx jev-events auth google    # sign in once
npx jev-events watch gmail    # your latest emails, judged, then new mail as it arrives
npx jev-events watch calendar # your next events, then new and changed ones
```

## In code

```ts
import { monitor, recipes } from "jev-events";
import { google } from "@jev-events/google";

// Newsletters out of the inbox, and a label on mail that needs a reply.
const mail = monitor({
  source: google.gmail.inbox(),
  questions: { kind: recipes.email.kind, needsReply: recipes.email.needsReply },
})
  .on("kind:newsletter", { min: 0.9 }, google.gmail.archive())
  .on("needsReply", { min: 0.8 }, google.gmail.label("Needs reply"));

// Invites you haven't answered: flag the ones that matter, turn down sales pitches.
const invites = monitor({
  source: google.calendar.invites(),
  questions: { important: recipes.calendar.important, likelySales: recipes.calendar.likelySales },
})
  .on("important", { min: 0.8 }, (e) => console.log(`Don't miss "${e.item.title}"`))
  .on("likelySales", { min: 0.9 }, google.calendar.decline({ comment: "Thanks, but I'll pass." }));

// Reads the account `npx jev-events auth google` saved, and checks every 15 and 30 seconds.
await Promise.all([mail.start(), invites.start()]);
```

Actions are dry-run until you pass `dryRun: false` to `monitor()`: they log what they would do and
change nothing.

## For your users

Register your OAuth client with a runtime, mount its handler, and send people to `/connect/google`:

```ts
// lib/jev.ts
import { postgresStore, runtime } from "jev-events";
import { google } from "@jev-events/google";

export const jev = runtime({
  monitors: [mail, invites],
  store: postgresStore(pool),
  apps: [google.app()], // GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
  signIn: { user: (request) => yourUserId(request) },
});

// app/api/jev/[...path]/route.ts
export const GET = jev.handle;
export const POST = jev.handle;
```

Create the OAuth client as a "Web application" at
[console.cloud.google.com/auth/clients](https://console.cloud.google.com/auth/clients/create), with
`https://<your site>/api/jev/callback/google` as its redirect URI. `google.app({ scopes: ["calendar"] })`
asks for Calendar only.

## Sign-in on your machine or server

`npx jev-events auth google` walks you through creating your own OAuth client the first time (four
steps, about three minutes), then opens Google's consent page. It saves the account to
`.jev-events/store.json`, which only your user can read and git ignores. Set `JEV_EVENTS_KEY` to
encrypt the tokens in it. Renewed tokens are saved back automatically.

On a server that watches one account of your own, `google.fromEnv()` builds the connection from
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN`:

```ts
await mail.start({ connections: [google.fromEnv()] });
```

## Sources

| Source | Emits | Checks |
| --- | --- | --- |
| `google.gmail.inbox({ backfill?, label?, protect? })` | Each new email in the inbox, or under `label` | every 15s |
| `google.calendar.events({ calendarId?, backfill?, protect? })` | New events, and events whose details change (not just who's coming) | every 30s |
| `google.calendar.invites({ calendarId?, backfill?, protect? })` | Invites waiting for your answer, again if they change before you answer | every 30s |

`backfill: 5` also emits the 5 latest emails, or next events, on the first check. Pass `every` to
`monitor()` to check more or less often.

## Actions

| Action | What it does |
| --- | --- |
| `google.gmail.trash()` | Moves the email to Trash, where Gmail keeps it for 30 days |
| `google.gmail.archive()` | Takes it out of the inbox |
| `google.gmail.label(name)` | Adds a label, creating it the first time |
| `google.gmail.star()` | Stars it |
| `google.gmail.markRead()` | Marks it as read |
| `google.gmail.draftReply(text)` | Saves a reply as a draft. It is never sent |
| `google.calendar.accept({ comment? })` | Says yes to the invite |
| `google.calendar.decline({ comment? })` | Says no |
| `google.calendar.maybe({ comment? })` | Answers maybe |
| `google.calendar.respond(answer, { comment? })` | `"accepted"`, `"declined"` or `"maybe"`, chosen in code |

Actions skip mail and invites from people at your company and people you've emailed before. Change
who is protected with the source's `protect` option, such as
`google.gmail.inbox({ protect: { addresses: ["boss@acme.com"], except: ["noreply@acme.com"] } })`.
Nothing is ever deleted permanently or sent.

## License

MIT. Jev Events is a community project built on TypeSafe's Jev. It is not affiliated with or endorsed by
TypeSafe or Google.
