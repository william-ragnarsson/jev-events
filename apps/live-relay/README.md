# Live relay

The service behind the live feed on [jevevents.dev](https://jevevents.dev). It reads one public Twitch
chat anonymously, labels messages with Jev through `jev-events`, and streams the labels to the landing
page. It never acts on anyone: its source is read-only, so there is nothing to arm.

It runs as a long-lived Node process, because a serverless function can't hold a Twitch connection.

## What it sends

- **Anonymized users.** Usernames become stable nicknames such as `viewer-4821`, keyed with a secret
  that's random for each run of the process. Real names never leave the relay. Links and @mentions in
  messages are masked.
- **No hateful text.** Messages at least `HIDE_AT` likely to be hateful are sent without their text,
  and the page shows "hidden by Jev" instead.
- **Only labeled messages.** At most `MAX_JUDGMENTS_PER_SEC` requests go to Jev each second, and repeated
  messages reuse a cached answer. The rest of chat is skipped, not shown unlabeled.
- **Nothing stored.** The last 50 entries are kept in memory for people who just arrived.

## Endpoints

| Endpoint | Returns |
| --- | --- |
| `GET /feed` | Server-sent events: `hello` (status and recent entries), then `message` and `status` |
| `GET /status` | Channel, viewers, messages per second, judgments, tokens and spend today, p50 and p95 latency |
| `GET /healthz` | `200 ok` while the process is up |

## Cost controls

- The relay connects to Twitch only while someone has the page open, and leaves
  `IDLE_DISCONNECT_SECONDS` after the last viewer.
- It moves to another channel when chat is silent for 90 seconds.
- A daily input-token budget stops labeling when spent. The page then plays its recorded replay.
- Identical messages, such as copy-paste floods, reuse a cached answer.

The budget is counted in memory, so **a restart resets the day's count**. Run one instance that stays up,
rather than one that scales to zero and restarts many times a day.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | | Required. [Get a key](https://docs.typesafe.ai/introduction/quickstart) |
| `LIVE_CHANNELS` | | Channels to read, such as `channel_a,channel_b`. Required unless the Twitch app below is set |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | | A Twitch app. With it, the relay picks busy live channels from Twitch's directory and prefers `LIVE_CHANNELS` when they're live |
| `BLOCKED_CHANNELS` | | Never read these |
| `MAX_JUDGMENTS_PER_SEC` | `5` | Jev requests per second |
| `DAILY_TOKEN_BUDGET` | `40000000` | Input tokens per UTC day, about $1.70 |
| `IDLE_DISCONNECT_SECONDS` | `60` | Leave Twitch this long after the last viewer |
| `HIDE_AT` | `0.5` | Hide messages at least this likely to be hateful |
| `ALLOWED_ORIGINS` | `*` | Exact origins that may read the feed from a browser, such as `https://jevevents.dev` |
| `MAX_VIEWERS` | `500` | Feed connections at once |
| `PORT` | `8790` | |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

The Twitch app here is a confidential app with a client secret, used only for an app token to list live
streams. It's a different app from the Public one that `jev-events auth twitch` uses.

## Run it locally

```bash
TYPESAFE_API_KEY=... LIVE_CHANNELS=<channel> npm start -w @jev-events/live-relay
NEXT_PUBLIC_RELAY_URL=http://localhost:8790 npm run dev -w @jev-events/web
```

To work on the page without a key, `npm run mock-jev` starts a stand-in for Jev on port 8799. Point the
relay at it with `TYPESAFE_API_KEY=mock TYPESAFE_BASE_URL=http://127.0.0.1:8799`. Its labels are keyword
guesses and mean nothing.

## Record a replay

When the relay is down, out of budget or not configured, the page plays `apps/web/public/replay.jsonl`,
a recorded session. Record one with a real key while a busy channel is live:

```bash
TYPESAFE_API_KEY=... LIVE_CHANNELS=<channel> npm run record -w @jev-events/live-relay -- --minutes 10
```

The page presents the replay's latency and spend as measured, so recording refuses to run against a local
`TYPESAFE_BASE_URL` such as the mock. The file holds the same anonymized entries the feed sends. Read it
before you commit it.

## Deploy

The Dockerfile builds from the repository root:

```bash
docker build -f apps/live-relay/Dockerfile -t jev-events-relay .
docker run -p 8790:8790 -e TYPESAFE_API_KEY=... -e LIVE_CHANNELS=<channel> jev-events-relay
```

Any host that runs a container and keeps connections open works. On Fly.io or Railway:

- Point the service at `apps/live-relay/Dockerfile`, with the repository root as the build context.
- Serve port `8790`, or let the host set `PORT`.
- Keep one instance running. Scaling to zero resets the daily budget on every start.
- Set `ALLOWED_ORIGINS=https://jevevents.dev` and the secrets above.
- Use `/healthz` as the health check.

Then set `NEXT_PUBLIC_RELAY_URL` to the relay's public URL in the website's environment and redeploy
the site. The variable is read at build time.
