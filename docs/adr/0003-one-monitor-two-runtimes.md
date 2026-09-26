# One monitor, two runtimes

The same monitor runs inside the product's web app, as a webhook route plus a cron route that polls and
renews subscriptions, or as an always-on worker. Google, Microsoft and Slack deliver by webhook, so most
products can use them without deploying anything new. Twitch and Discord hold sockets and need the
worker. We chose both over a worker-only design because the products we target are mostly web apps on
serverless hosts.

## Consequences

Nothing can live in process memory between calls. Cursors, push subscriptions and the record of which
actions already ran all go through storage, in both runtimes.
