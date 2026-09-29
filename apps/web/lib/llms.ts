/**
 * The docs as agents read them, in `/llms-full.txt` and each page's markdown. The site's own
 * components only render in a browser, so each becomes plain markdown with its code and numbers.
 * Tags that only lay the page out, such as <Steps> and <Rows>, are dropped, and so are the parts
 * a code fence marks in blue.
 */

import { site } from './site.ts';
import { CATALOG, type IntegrationId } from './builder/catalog.ts';
import type { RecipeEntry } from './builder/generate.ts';
import { builderMarkdown, fence } from './builder/markdown.ts';

export interface DocsData {
  snippets: Readonly<Record<string, string>>;
  recipes: readonly RecipeEntry[];
  dataset: { items: number; borderline: number; languages: number; nonEnglish: number };
}

/** The site's components that `llmsText` replaces. */
export const COMPONENTS = ['Snippet', 'RecipeList', 'Dataset', 'BenchmarkReport', 'Builder', 'AgentPrompt'] as const;

/** A prop, quoted either way: `title="monitor.ts"` or `mark='"kind:newsletter"'`. */
const PROP = `(\\w+)=(?:"([^"]*)"|'([^']*)')`;
const TAG = new RegExp(`<(${COMPONENTS.join('|')})((?:\\s+${PROP})*)\\s*/>`, 'g');

/** A tag that only lays a page out, from its line to its closing one. */
const LAYOUT = /^([ \t]*)<(Steps|Step|Rows)>[ \t]*\n([\s\S]*?)^\1<\/\2>[ \t]*$/m;
/** What a fence marks in blue, on its info line. */
const MARK = /^([ \t]*```.*?) mark=(?:"[^"]*"|'[^']*')/gm;

/**
 * Takes out the tags that only lay a page out, keeping what's inside them. Fumadocs' processed
 * markdown indents what's inside a tag by two spaces, and that indent goes too.
 */
function unwrap(markdown: string): string {
  let text = markdown;
  for (let match = LAYOUT.exec(text); match; match = LAYOUT.exec(text)) {
    const [block, indent = '', , inside = ''] = match;
    const lines = inside.split('\n');
    const nested = lines.every((line) => line.trim() === '' || line.startsWith(`${indent}  `));
    const body = nested ? lines.map((line) => line.slice(indent.length + 2)).join('\n') : inside;
    text = [text.slice(0, match.index), body, text.slice(match.index + block.length)]
      .map((part) => part.replace(/^\n+|\n+$/g, ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return text;
}

export function llmsText(markdown: string, data: DocsData): string {
  return unwrap(markdown).replace(MARK, '$1').replace(TAG, (tag, name: (typeof COMPONENTS)[number], attributes: string) => {
    const props = Object.fromEntries(
      [...attributes.matchAll(new RegExp(PROP, 'g'))].map((match) => [match[1], match[2] ?? match[3]]),
    );
    switch (name) {
      case 'Snippet': {
        const code = props.name ? data.snippets[props.name] : undefined;
        return code === undefined ? tag : fence('ts', code, props.title ?? `${props.name}.ts`);
      }
      case 'RecipeList': {
        const recipes = data.recipes.filter((recipe) => recipe.group === props.group);
        return recipes.length > 0 ? recipes.map(recipeMarkdown).join('\n') : tag;
      }
      case 'Dataset': {
        const { dataset } = data;
        const counts: Record<string, number> = { ...dataset, otherLanguages: dataset.languages - 1 };
        const count = props.field ? counts[props.field] : undefined;
        return count === undefined ? tag : String(count);
      }
      case 'BenchmarkReport':
        return `The results render on the website: ${site.url}/docs/benchmarks`;
      case 'Builder':
        return props.integration && props.integration in CATALOG ? builderMarkdown(props.integration as IntegrationId, data.recipes) : tag;
      case 'AgentPrompt':
        return '';
    }
  });
}

const TYPES: Record<string, string> = { noul: 'yes/no', choice: 'choice', score: 'score' };

function recipeMarkdown(recipe: RecipeEntry): string {
  const lines = [`- \`${recipe.usage}\` (${TYPES[recipe.type] ?? recipe.type}): ${String(recipe.instructions)}`];
  const { criteria } = recipe;
  if (Array.isArray(criteria)) {
    criteria.forEach((level, index) => lines.push(`  - ${index}: ${String(level)}`));
  } else if (criteria && typeof criteria === 'object') {
    for (const [key, value] of Object.entries(criteria)) {
      const name = recipe.type === 'choice' ? `\`"${recipe.id}:${key}"\`` : key === 'true' ? 'yes' : key === 'false' ? 'no' : key;
      lines.push(`  - ${name}: ${value === null ? 'anything else' : String(value)}`);
    }
  }
  return lines.join('\n');
}
