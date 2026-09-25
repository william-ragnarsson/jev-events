import recipes from '@/generated/recipes.json';
import { cn } from '@/lib/cn';

interface Recipe {
  usage: string;
  group: string;
  id: string;
  type: string;
  instructions: unknown;
  criteria: unknown;
}

const OUTCOME: Record<string, string> = {
  choice: 'One event per label',
  noul: 'Fires above your probability',
  score: 'Fires at or above your score',
};

/** Every recipe in a group, rendered from the library's own definitions. */
export function RecipeList({ group }: { group: string }) {
  const list = (recipes as Recipe[]).filter((recipe) => recipe.group === group);
  return (
    <div className="not-prose my-6 grid grid-cols-1 gap-4">
      {list.map((recipe) => (
        <article key={recipe.usage} id={`${recipe.group}-${recipe.id}`} className="scroll-mt-24 rounded-xl border bg-fd-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-[13px] font-medium">{recipe.usage}</code>
            <span className="rounded-md border px-1.5 py-0.5 font-mono text-[10px] text-fd-muted-foreground uppercase">
              {recipe.type}
            </span>
            <span className="text-xs text-fd-muted-foreground">{OUTCOME[recipe.type]}</span>
          </div>
          <p className="mt-2 text-sm">{String(recipe.instructions)}</p>
          <Criteria type={recipe.type} criteria={recipe.criteria} id={recipe.id} />
        </article>
      ))}
    </div>
  );
}

function Criteria({ type, criteria, id }: { type: string; criteria: unknown; id: string }) {
  if (criteria === null || criteria === undefined) return null;
  const rows: Array<[string, string]> = Array.isArray(criteria)
    ? criteria.map((level, index) => [String(index), String(level)])
    : Object.entries(criteria as Record<string, unknown>).map(([key, value]) => [key, value === null ? '' : String(value)]);
  return (
    <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t pt-3 text-[13px]">
      {rows.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className={cn('font-mono text-xs text-fd-muted-foreground', type === 'choice' && 'text-fd-foreground')}>
            {type === 'choice' ? `"${id}:${key}"` : type === 'score' ? `${key}` : key === 'true' ? 'yes' : 'no'}
          </dt>
          <dd className="text-fd-muted-foreground">{value || '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
