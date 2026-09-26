# @jev-events/google

Gmail and Google Calendar for [Jev Events](https://jevevents.dev). Ask Jev about every new email and
calendar event, then trash, archive, label or answer invites, in your own account.

[Google guide](https://jevevents.dev/docs/integrations/google) · [Quickstart](https://jevevents.dev/docs/quickstart) ·
[GitHub](https://github.com/william-popmie/jev-events)

```bash
npm i jev-events @jev-events/google
```

```ts
import { listen, recipes } from "jev-events";
import { google } from "@jev-events/google";

// `npx jev-events auth google` signs you in and saves the tokens.
const auth = google.auth.fromFile();

// The meetings that matter, out of everything on the calendar.
const calendar = listen(google.calendar.events({ auth }), {
  important: recipes.calendar.important,
  likelySales: recipes.calendar.likelySales,
});

calendar
  .on("important", { min: 0.8 }, (e) => notify(`Don't miss "${e.item.title}"`))
  .on("likelySales", { min: 0.9 }, google.calendar.decline({ comment: "Thanks, but I'll pass." }));

// Newsletters out of the inbox, and a label on mail that needs a reply.
const mail = listen(google.gmail.inbox({ auth }), {
  kind: recipes.email.kind,
  needsReply: recipes.email.needsReply,
});

mail
  .on("kind:newsletter", { min: 0.9 }, google.gmail.archive())
  .on("needsReply", { min: 0.8 }, google.gmail.label("Needs reply"));

await Promise.all([calendar.start(), mail.start()]); // dry-run until you pass { dryRun: false }
```

## Sign in

```bash
npx jev-events auth google
```

The first time, it walks you through creating your own Google OAuth client in four steps, then opens
Google's consent page. The tokens are saved to `.jev-events/credentials.json`, which only your user can
read, and refreshed tokens are written back automatically.

On a server, `google.auth.fromEnv()` reads `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
`GOOGLE_REFRESH_TOKEN`. If you store tokens yourself, `google.auth.withTokens(tokens, onRefresh)` hands
you refreshed tokens to save.

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

Native actions skip mail and invites from people at your company and people you've emailed. Change that
with the `protect` option. Nothing is ever deleted permanently or sent.

## License

MIT. Jev Events is a community project built on TypeSafe's Jev. It is not affiliated with or endorsed by
TypeSafe or Google.
