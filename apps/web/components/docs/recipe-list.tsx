import { Fragment } from 'react';

import recipes from '@/generated/recipes.json';
import { InlineCode } from './inline-code';

interface Recipe {
  usage: string;
  group: string;
  id: string;
  type: string;
  instructions: unknown;
  criteria: unknown;
}

const OUTCOME: Record<string, string> = {
  choice: 'One label, each its own event',
  noul: 'Yes or no',
  score: 'A score on its scale',
};

/** Every recipe in a group on hairlines, rendered from the library's own definitions. */
export function RecipeList({ group }: { group: string }) {
  const list = (recipes as Recipe[]).filter((recipe) => recipe.group === group);
  return (
    <div className="docs-recipes">
      {list.map((recipe) => (
        <section key={recipe.usage} id={`${recipe.group}-${recipe.id}`} className="docs-recipe">
          <p className="docs-recipe-head">
            <InlineCode>{recipe.usage}</InlineCode>
            <span>{OUTCOME[recipe.type]}</span>
          </p>
          <p>{String(recipe.instructions)}</p>
          <Criteria type={recipe.type} criteria={recipe.criteria} id={recipe.id} />
        </section>
      ))}
    </div>
  );
}

/** What each outcome means: a choice's events, yes and no, or a score's levels. */
function Criteria({ type, criteria, id }: { type: string; criteria: unknown; id: string }) {
  if (criteria === null || criteria === undefined) return null;
  const rows: [string, string][] = Array.isArray(criteria)
    ? criteria.map((level, index) => [String(index), String(level)])
    : Object.entries(criteria as Record<string, unknown>).map(([key, value]) => [key, value === null ? '' : String(value)]);
  return (
    <dl>
      {rows.map(([key, value]) => (
        <Fragment key={key}>
          <dt>{type === 'choice' ? `"${id}:${key}"` : type === 'score' ? key : key === 'true' ? 'yes' : 'no'}</dt>
          <dd>{value || 'Anything else'}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
