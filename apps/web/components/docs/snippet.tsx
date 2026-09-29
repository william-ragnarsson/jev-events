import { highlight } from 'fumadocs-core/highlight';

import snippets from '@/generated/snippets.json';
import { MONO, transformerDocs } from '@/lib/docs-code';
import { Pre } from './code';

export type SnippetName = keyof typeof snippets;

/**
 * A code example from apps/web/snippets: real TypeScript, type-checked against the library in CI.
 * `mark` marks the parts that matter, split by `|`, the same as a fence's.
 */
export async function Snippet({ name, title, mark }: { name: SnippetName; title?: string; mark?: string }) {
  const file = title ?? `${name}.ts`;
  return highlight(snippets[name], {
    lang: 'ts',
    theme: MONO,
    transformers: [transformerDocs()],
    meta: mark ? { mark } : {},
    components: { pre: (props) => <Pre {...props} title={file} /> },
  });
}
