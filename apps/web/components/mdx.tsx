import Link from 'fumadocs-core/link';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps, ReactNode } from 'react';

import dataset from '@/generated/dataset.json';
import { AgentPrompt } from './docs/agent-prompt';
import { BenchmarkReport } from './docs/benchmark-report';
import { Builder } from './docs/builder';
import { Pre } from './docs/code';
import { InlineCode } from './docs/inline-code';
import { RecipeList } from './docs/recipe-list';
import { Snippet } from './docs/snippet';

/** Counts from the chat eval set, so prose about it stays true: <Dataset field="items" /> */
function Dataset({ field }: { field: 'items' | 'borderline' | 'languages' | 'otherLanguages' | 'nonEnglish' }) {
  return <>{field === 'otherLanguages' ? dataset.languages - 1 : dataset[field]}</>;
}

type Option = { type: string; description?: string; default?: string; required?: boolean };

/** A function's options: each one's name, then its type over what it does. */
function TypeTable({ type }: { type: Record<string, Option> }) {
  return (
    <div className="docs-table">
      <table>
        <thead>
          <tr>
            <th>Option</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(type).map(([name, option]) => (
            <tr key={name}>
              <td>
                <InlineCode>{name}</InlineCode>
              </td>
              <td>
                <InlineCode className="docs-type">{option.type}</InlineCode>
                {option.required ? 'Required. ' : null}
                {option.description}
                {option.default ? (
                  <>
                    {option.description ? ' ' : null}Defaults to <InlineCode>{option.default}</InlineCode>.
                  </>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * How the docs' markdown is drawn: see components/docs/docs.css. Steps number what's inside them,
 * and Rows turns a list of `**Label** text` items into label and text on hairlines.
 */
export function getMDXComponents(components?: MDXComponents) {
  return {
    a: Link,
    pre: Pre,
    code: InlineCode,
    table: (props: ComponentProps<'table'>) => (
      <div className="docs-table">
        <table {...props} />
      </div>
    ),
    Steps: ({ children }: { children?: ReactNode }) => <div className="docs-steps">{children}</div>,
    Step: ({ children }: { children?: ReactNode }) => <div className="docs-step">{children}</div>,
    Rows: ({ children }: { children?: ReactNode }) => <div className="docs-rows">{children}</div>,
    TypeTable,
    Snippet,
    RecipeList,
    BenchmarkReport,
    Dataset,
    Builder,
    AgentPrompt,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
