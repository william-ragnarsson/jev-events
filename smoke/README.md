# Smoke tests

`npm test` checks every integration offline, against local fakes of Twitch, Bluesky, Google, Slack and
Jev. These smoke tests run the same code against the real services, to catch the day a platform
changes something. They are opt-in and never run in CI.

```bash
npm run test:smoke
```

With nothing set, the public-stream tests run and the rest are skipped. That takes a few seconds and
needs no keys. To run one file, add part of its name: `npm run test:smoke -- jev`. Keys and tokens in
`.env` count, the same as for the CLI.

| File | Checks | Needs |
| --- | --- | --- |
| `public-streams.smoke.ts` | Bluesky's firehose delivers posts, filtered by language. Twitch chat can be read without an account. | Nothing (Jev is mocked) |
| `cli.smoke.ts` | `jev-events watch bluesky` prints judged posts, through the real SDK, to a local fake Jev. | Nothing |
| `jev.smoke.ts` | Real Jev answers yes-or-no and choice questions sensibly. Makes three requests. | `TYPESAFE_API_KEY` |
| `twitch-signed-in.smoke.ts` | Reads your channel's chat over EventSub as your account. Writes only with `SMOKE_TWITCH_WRITE=1`. | `auth twitch` |
| `google.smoke.ts` | Reads your latest emails and upcoming events. Writes only with `SMOKE_GOOGLE_WRITE=1`. | `auth google` |
| `slack.smoke.ts` | Connects over Socket Mode and reads the latest messages. Writes only with `SMOKE_SLACK_WRITE=1`. | `auth slack` |

## Settings

- `SMOKE_TWITCH_CHANNELS`: channels for the anonymous chat test, comma-separated. By default it
  watches eight big channels and passes as soon as any of them says something. Set it when none of
  them is live.
- `TYPESAFE_API_KEY`: runs `jev.smoke.ts`, which makes three real requests. It's skipped when
  `TYPESAFE_BASE_URL` points at a local stand-in.

## Signed-in Twitch

Sign in once. The first time, it walks you through making the Twitch app:

```bash
npm run cli -- auth twitch
```

That saves the account to `.jev-events/store.json`, which git ignores. `TWITCH_CLIENT_ID` and
`TWITCH_ACCESS_TOKEN` (or `TWITCH_REFRESH_TOKEN`) in the environment are used instead when set.

Then `npm run test:smoke -- twitch-signed-in` checks the account allowed every scope, finds the
channel and subscribes to its chat over EventSub. It reads your own channel; set
`SMOKE_TWITCH_CHANNEL=<channel>` to read another one, where the account has to be a moderator
(`/mod <account>`) for the writes below.

Add `SMOKE_TWITCH_WRITE=1` to check the actions too:

- It says a line in chat, failing if Twitch drops the message (AutoMod, for example).
- It waits up to two minutes for you to type a message with "jev test" from an account that isn't
  the broadcaster or a moderator, then deletes it. This is the whole path: live chat, EventSub, the
  monitor, the question, and the delete.
- With `SMOKE_TWITCH_TARGET=<login>` as well, it times that account out for one second. Use an alt
  account you own that isn't a moderator.

## Google

Sign in once. The first time, it walks you through making the OAuth client:

```bash
npm run cli -- auth google
```

Then `npm run test:smoke -- google` reads your latest emails and your next events. Add
`SMOKE_GOOGLE_WRITE=1` to also check the changes: it puts a test email straight into your inbox
(nothing is sent) and moves it to Trash, and adds an event tomorrow and deletes it again.

## Slack

Connect the app once. The first time, it walks you through making the Slack app:

```bash
npm run cli -- auth slack
```

Then `npm run test:smoke -- slack` connects over Socket Mode and reads the latest messages. Add
`SMOKE_SLACK_WRITE=1` to check the actions too: it waits up to two minutes for you to type a message
with "jev test" where the app can see it, then reacts with :eyes: and replies in its thread.
