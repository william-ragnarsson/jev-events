# Starter

Each file here watches one app and prints what Jev says about every new item. You fill in `.env`, run one command, and see it work. Each file is short, so you can copy it into your own code.

The scripts only print. Nothing is sent, moved or deleted in your accounts. Google and Slack still ask for permission to change things, because the same sign-in also works for Jev's actions.

## What works today

| App | File | What you need | Status |
| --- | --- | --- | --- |
| Bluesky, public posts | `bluesky.ts` | Only your TypeSafe key | Works |
| Twitch, any public chat | `twitch.ts` | Only your TypeSafe key | Works |
| Slack | `slack.ts` | A Slack app you make, about 2 minutes | Built, not yet run on a real workspace |
| Gmail | `gmail.ts` | A Google OAuth client you make, about 10 minutes ([GOOGLE.md](GOOGLE.md)) | Built, not yet run on a real account |
| Google Calendar | `calendar.ts` | The same Google client as Gmail | Built, not yet run on a real account |
| Twitch, as you (timeouts, deletes) | [`../twitch-moderator`](../twitch-moderator/index.ts) | A Twitch app you make | Built, not yet run on a real account |
| Outlook, Outlook Calendar, Teams | none | A Microsoft Entra app you make | Code exists, no docs yet |
| Discord, GitHub, Linear, Notion, Google Drive, YouTube | none | | Not built yet |
| Anything else | none | Send your own items with `from()` or `webhook()` | Works |

## Set up once

You need Node 22.9 or newer (`node -v`). From the repo root:

```bash
npm install
cd examples/starter
cp .env.example .env
```

Open `.env` and paste your TypeSafe key after `TYPESAFE_API_KEY=`. Get one at [docs.typesafe.ai](https://docs.typesafe.ai/introduction/quickstart).

## Bluesky

```bash
npm run bluesky
```

It prints posts that mention music as they're posted, one every few seconds. Change the word in `bluesky.ts`.

## Twitch

Open twitch.tv, pick any stream that is live now, and use the name at the end of its link (twitch.tv/**name**):

```bash
npm run twitch -- <name>
```

## Slack

1. Run `npm run slack`. Without tokens it prints a long link and stops. Open the whole link, pick your workspace, click **Next**, then **Create**.
2. Click **Install to Workspace**, then **Allow**.
3. Under **OAuth & Permissions**, copy the **Bot User OAuth Token** (`xoxb-…`) into `.env` as `SLACK_BOT_TOKEN`.
4. Under **Basic Information → App-Level Tokens**, click **Generate Token and Scopes**. Name it anything, add the `connections:write` scope, click **Generate**, and copy the token (`xapp-…`) into `.env` as `SLACK_APP_TOKEN`.
5. In Slack, open a channel and type `/invite @jev_events`. The app only sees channels it's in, and direct messages to it.
6. Run `npm run slack` again, then post a message in that channel.

## Gmail and Calendar

Google wants an app of your own (an OAuth client) and your permission for it to read your mail. [GOOGLE.md](GOOGLE.md) walks through every screen and every error message. In short, in the [Google Cloud console](https://console.cloud.google.com):

1. [Create a project](https://console.cloud.google.com/projectcreate), and check it's the one selected in the top bar.
2. [Turn on the Gmail and Calendar APIs](https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com).
3. [Set up the Google Auth platform](https://console.cloud.google.com/auth/overview): **Get started**, any app name, your email, **External**, tick the agreement, **Create**. Then under **Audience → Test users**, add your own Gmail address.
4. Under [Clients](https://console.cloud.google.com/auth/clients), create a **Desktop app** client. Before you close the window, paste its **Client ID** after `GOOGLE_CLIENT_ID=` and its **Client secret** after `GOOGLE_CLIENT_SECRET=` in `.env`. Google shows the secret only once.

Then sign in:

```bash
npm run google-token
```

Open the link it prints and pick the account you added as a test user. Google warns that it hasn't verified the app. It's yours, so click **Continue** (the small link, not **Back to safety**), or **Advanced** and then **Go to … (unsafe)**. Tick **Select all** and click **Continue**. The terminal then prints a `GOOGLE_REFRESH_TOKEN=…` line. Put it in `.env` in place of the empty `GOOGLE_REFRESH_TOKEN=` line.

```bash
npm run gmail
npm run calendar
```

While the app is in Testing, Google signs you out after 7 days. Then run `npm run google-token` again and replace the line. [GOOGLE.md](GOOGLE.md#staying-signed-in) shows how to stop that.

## How it works

Every file has the same parts.

```ts
const mail = monitor({
  source: google.gmail.inbox(), // 1. where items come from
  questions: { kind: choice("What kind of email is this?", { personal: "…", newsletter: "…", other: null }) }, // 2. what to ask
});
mail.on("kind:personal", (e) => console.log(e.item.subject)); // 3. what to do with the answer

await mail.start({ connections: [google.fromEnv()] }); // 4. whose account to read (Slack and Google only)
```

- **Questions.** `noul("…")` is a yes/no question. Its answer is how likely yes is, from 0 to 1. `choice("…", { … })` picks one of your labels.
- **Events.** Each question becomes an event: `"asks"` for a noul question named `asks`, and `"kind:personal"` for the label `personal` of a choice named `kind`. A typo is a type error. A yes/no event runs when Jev is at least 50% sure, and `{ min: 0.8 }` raises that to 80%. A label event runs when Jev picks that label. `"judged"` runs for every item.
- **Accounts.** Public Bluesky and Twitch need none. Slack gives you two tokens to copy. Google needs two things: your app (the client ID and secret) and your permission for that app to read your mail. The refresh token is that permission, saved, so the script doesn't ask you to sign in each time. `fromEnv()` reads them from the environment, and `npm run` loads `.env` into it (`--env-file-if-exists=.env` in `package.json`). Do the same when you copy a file into your own project.
- **Cost.** Each judged item is one paid TypeSafe request. Bluesky and Twitch are limited to one or two a second with `rate`. Posts that wait more than 10 seconds are skipped.
- **New items only.** Every run starts from now. `backfill: 3` also judges the 3 newest Slack messages or emails, or your next 3 calendar events, so you see something straight away.
