import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

import { Logo } from '@/components/logo';
import { site } from './site';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <Logo className="size-6" />
          <span className="font-semibold tracking-tight">{site.name}</span>
        </>
      ),
    },
    githubUrl: site.github,
    links: [
      { text: 'Docs', url: '/docs', active: 'nested-url' },
      { text: 'Recipes', url: '/docs/recipes' },
      { text: 'Benchmarks', url: '/docs/benchmarks' },
    ],
  };
}
