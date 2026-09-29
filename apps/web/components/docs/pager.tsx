'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { CopyButton } from './code';

async function markdown(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

/** The foot of every docs page: the page on GitHub, the page as Markdown, and the next page. */
export function Pager({
  editUrl,
  markdownUrl,
  next,
}: {
  editUrl: string;
  markdownUrl: string;
  next?: { name: ReactNode; url: string };
}) {
  return (
    <div className="docs-pager">
      <div className="docs-pager-tools">
        <a href={editUrl} className="docs-pager-edit" target="_blank" rel="noreferrer">
          Edit this page on GitHub
        </a>
        <CopyButton className="docs-pager-copy" label="Copy this page as Markdown" text={() => markdown(markdownUrl)} />
      </div>
      {next ? (
        <Link href={next.url} className="docs-pager-next">
          <span>Next</span>
          <span>{next.name} →</span>
        </Link>
      ) : null}
    </div>
  );
}
