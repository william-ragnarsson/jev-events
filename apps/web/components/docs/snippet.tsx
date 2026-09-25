import snippets from '@/generated/snippets.json';
import { Code } from '../code';

export type SnippetName = keyof typeof snippets;

/** A code example from apps/web/snippets: real TypeScript, type-checked against the library in CI. */
export function Snippet({ name, title }: { name: SnippetName; title?: string }) {
  return <Code code={snippets[name]} title={title ?? `${name}.ts`} className="my-6" />;
}
