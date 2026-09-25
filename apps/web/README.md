# jevevents.dev

The landing page and docs for Jev Events. Built with Next.js, Tailwind CSS and Fumadocs.

```bash
npm run dev -w @jev-events/web   # http://localhost:3000
```

| Path | What's there |
| --- | --- |
| `app/(home)` | The landing page |
| `app/docs`, `content/docs` | The docs, written in MDX |
| `app/og`, `lib/og.tsx` | Social preview images, rendered at build time |
| `components/live-feed.tsx`, `components/relay` | The live feed and its connection to the [relay](../live-relay) |
| `snippets` | Code examples for the site. They're type-checked, and `snippets/testing.ts` runs as a test |
| `generated` | Data for the site: snippets, recipes, the relay's source, the dataset summary and benchmark results |
| `public/replay.jsonl` | A recorded session, played when the relay is unavailable. [Record one](../live-relay#record-a-replay) |

## Generated data

Numbers and code on the site come from the repository, not from copies typed into pages.

```bash
npm run site:data     # snippets, recipes, the relay's source and the dataset summary
npm run eval:report   # benchmark results from evals/results
```

Run them after changing a snippet, a recipe, the relay or the dataset. `npm test` fails when the
generated files are stale.

## Environment

| Variable | |
| --- | --- |
| `NEXT_PUBLIC_RELAY_URL` | The live relay's public URL. Read at build time. Unset, the page plays its replay |

## Deploy on Vercel

Import the repository and set the project's **Root Directory** to `apps/web`. Vercel detects Next.js and
the npm workspace. Add `NEXT_PUBLIC_RELAY_URL` once the relay is running, then redeploy.
