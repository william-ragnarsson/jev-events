import type { Node } from 'fumadocs-core/page-tree';

import { Sidebar, type SidebarGroup, type SidebarSection } from '@/components/docs/sidebar';
import { Footer } from '@/components/site/footer';
import { Nav } from '@/components/site/nav';
import { INTEGRATIONS } from '@/lib/builder/catalog';
import { source } from '@/lib/source';
import '@/components/docs/docs.css';

/** The pages in the order of meta.json, a new group at each `---Name---`. */
function groups(nodes: Node[]): SidebarGroup[] {
  const out: SidebarGroup[] = [{ pages: [] }];
  const add = (node: Node) => {
    if (node.type === 'separator') out.push({ name: node.name, pages: [] });
    else if (node.type === 'page') out[out.length - 1].pages.push({ name: node.name, url: node.url });
    else {
      if (node.index) add(node.index);
      node.children.forEach(add);
    }
  };
  nodes.forEach(add);
  return out.filter((group) => group.pages.length > 0);
}

/** Headings that come from components, not the page's markdown, so they're missing from its toc. */
const FIRST: Record<string, SidebarSection[]> = {
  '/docs': [{ title: 'Set it up with your agent', url: '#agent' }],
  ...Object.fromEntries(INTEGRATIONS.map((spec) => [spec.docs, [{ title: 'Run it', url: '#run-it' }]])),
};

/** Each page's sections: its h2s, less a closing Next, which only points on, as the pager does. */
function sections(): Record<string, SidebarSection[]> {
  return Object.fromEntries(
    source.getPages().map((page) => [
      page.url,
      [
        ...(FIRST[page.url] ?? []),
        ...page.data.toc
          .filter((item) => item.depth === 2 && item.url !== '#next')
          .map((item) => ({ title: item.title, url: item.url })),
      ],
    ]),
  );
}

export default function Layout({ children }: LayoutProps<'/docs'>) {
  return (
    <div className="site">
      <Nav current="/docs" />
      <div className="docs">
        <Sidebar groups={groups(source.getPageTree().children)} sections={sections()} />
        {children}
      </div>
      <Footer onPaper />
    </div>
  );
}
