import { findNeighbour } from 'fumadocs-core/page-tree';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ComponentType, SVGProps } from 'react';

import { GmailIcon, GoogleCalendarIcon, SlackIcon, TwitchIcon } from '@/components/brand-icons';
import { Pager } from '@/components/docs/pager';
import { getMDXComponents } from '@/components/mdx';
import { INTEGRATIONS, type IntegrationId } from '@/lib/builder/catalog';
import { getPageImageUrl, getPageMarkdownUrl, gitConfig } from '@/lib/shared';
import { source } from '@/lib/source';

const ICONS: Record<IntegrationId, ComponentType<SVGProps<SVGSVGElement>>> = {
  gmail: GmailIcon,
  calendar: GoogleCalendarIcon,
  slack: SlackIcon,
  twitch: TwitchIcon,
};

export default async function Page(props: PageProps<'/docs/[[...slug]]'>) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const integration = INTEGRATIONS.find((spec) => spec.docs === page.url);
  const Icon = integration ? ICONS[integration.id] : null;
  const next = findNeighbour(source.getPageTree(), page.url).next;

  return (
    <main id="main" className="docs-main">
      <h1>
        {Icon ? <Icon aria-hidden="true" /> : null}
        {page.data.title}
      </h1>
      {page.data.description ? <p className="docs-lead">{page.data.description}</p> : null}
      <MDX components={getMDXComponents({ a: createRelativeLink(source, page) })} />
      <Pager
        editUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/${gitConfig.contentDir}/${page.path}`}
        markdownUrl={getPageMarkdownUrl(page).url}
        next={next ? { name: next.name, url: next.url } : undefined}
      />
    </main>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps<'/docs/[[...slug]]'>): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    openGraph: {
      images: getPageImageUrl(page).url,
    },
  };
}
