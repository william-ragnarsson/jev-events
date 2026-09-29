# jevevents.dev

The landing page and docs for Jev Events. Built with Next.js, Tailwind CSS and Fumadocs.

```bash
npm run dev -w @jev-events/web   # http://localhost:3000
```

| Path | What's there |
| --- | --- |
| `app/(home)`, `components/home`, `components/try` | The home page and Try it, the live Twitch demo |
| `components/site` | The nav and footer every page shares |
| `app/docs`, `content/docs` | The docs, written in MDX |
| `app/og`, `lib/og.tsx` | Social preview images, rendered at build time |
| `components/docs`, `lib/docs-code.ts` | The docs' sidebar, pager and code blocks, and the parts of code they mark in blue |
| `lib/builder` | The builder on each integration's page and the prompt at the top of the docs. Both write a project's code from what the reader picks |
| `lib/llms.ts` | `/llms.txt`, `/llms-full.txt` and each page as Markdown, for coding agents |
| `snippets` | Code examples for the site. They're type-checked, and the `snippets/testing*.ts` examples run as tests |
| `generated` | Data for the site: snippets, recipes, the dataset summary and benchmark results |

## Generated data

Numbers and code on the site come from the repository, not from copies typed into pages.

```bash
npm run site:data     # snippets, recipes and the dataset summary
npm run eval:report   # benchmark results from evals/results
```

Run them after changing a snippet, a recipe or the dataset. `npm test` fails when the
generated files are stale.

## Deploy on Vercel

Import the repository and set the project's **Root Directory** to `apps/web`. Vercel detects Next.js and
the npm workspace.
