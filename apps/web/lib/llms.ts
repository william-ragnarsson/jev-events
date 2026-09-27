/**
 * The docs as agents read them, in `/llms-full.txt` and each page's markdown. The site's own
 * components only render in a browser, so each becomes plain markdown with its code and numbers.
 * Fumadocs' prose components, such as <Steps> and <Callout>, read fine as they are.
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

const TAG = new RegExp(`<(${COMPONENTS.join('|')})((?:\\s+\\w+="[^"]*")*)\\s*/>`, 'g');

export function llmsText(markdown: string, data: DocsData): string {
  return markdown.replace(TAG, (tag, name: (typeof COMPONENTS)[number], attributes: string) => {
    const props = Object.fromEntries([...attributes.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
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
