import dataset from '@/generated/dataset.json';
import recipes from '@/generated/recipes.json';
import snippets from '@/generated/snippets.json';
import { llms, loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';
import { docsContentRoute, docsImageRoute, docsRoute } from './shared';
import { defineDocs } from 'fumadocs-mdx/macro';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { llmsText } from './llms';

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: pageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin()],
});

// What agents read: the site's own components become markdown, so every page's code is there.
export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${llmsText(await page.data.getText('processed'), { snippets, recipes, dataset })}`,
});
