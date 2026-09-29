import dataset from '@/generated/dataset.json';
import recipes from '@/generated/recipes.json';
import snippets from '@/generated/snippets.json';
import { llms, loader } from 'fumadocs-core/source';
import { docsRoute } from './shared';
import { defineDocs } from 'fumadocs-mdx/macro';
import { applyMdxPreset } from 'fumadocs-mdx/config';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { MONO, parseMeta, transformerDocs } from './docs-code';
import { llmsText } from './llms';
import { rehypeTableLabels } from './table-labels';

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: pageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
    // Fumadocs' defaults, but code in the docs' own look (see lib/docs-code.ts), and tables that
    // stack on a phone (see lib/table-labels.ts).
    mdxOptions: applyMdxPreset({
      rehypeCodeOptions: {
        themes: { light: MONO },
        defaultColor: 'light',
        transformers: [transformerDocs()],
        parseMetaString: parseMeta,
        icon: false,
        tab: false,
      },
      rehypePlugins: [rehypeTableLabels],
    }),
  },
  meta: {
    schema: metaSchema,
  },
});

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
});

// What agents read: the site's own components become markdown, so every page's code is there.
export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${llmsText(await page.data.getText('processed'), { snippets, recipes, dataset }).trim()}`,
});
