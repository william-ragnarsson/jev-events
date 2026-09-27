import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';

import dataset from '@/generated/dataset.json';
import { AgentPrompt } from './docs/agent-prompt';
import { BenchmarkReport } from './docs/benchmark-report';
import { Builder } from './docs/builder';
import { RecipeList } from './docs/recipe-list';
import { Snippet } from './docs/snippet';

/** Counts from the chat eval set, so prose about it stays true: <Dataset field="items" /> */
function Dataset({ field }: { field: 'items' | 'borderline' | 'languages' | 'otherLanguages' | 'nonEnglish' }) {
  return <>{field === 'otherLanguages' ? dataset.languages - 1 : dataset[field]}</>;
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Step,
    Steps,
    Tab,
    Tabs,
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
