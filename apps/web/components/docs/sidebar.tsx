'use client';

import { useSearchContext } from 'fumadocs-ui/contexts/search';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment, type ReactNode, useId, useState, useSyncExternalStore } from 'react';

export type SidebarPage = { name: ReactNode; url: string };
export type SidebarGroup = { name?: ReactNode; pages: SidebarPage[] };
export type SidebarSection = { title: ReactNode; url: string };

const subscribe = () => () => {};
const onMac = () => /Mac|iPhone|iPad/.test(navigator.userAgent);

/**
 * Every docs page in its group, with the current page's sections under it: the docs' only table of
 * contents. It lives in the layout, so it keeps its scroll as pages change. On tablets and phones
 * the pages fold away under Menu.
 */
export function Sidebar({ groups, sections }: { groups: SidebarGroup[]; sections: Record<string, SidebarSection[]> }) {
  const pathname = usePathname();
  const { setOpenSearch } = useSearchContext();
  // The server can't tell, so it prints ⌘K, and other systems get Ctrl K once the page loads.
  const mac = useSyncExternalStore(subscribe, onMac, () => true);
  const id = useId();
  // Menu stays open only on the page it was opened on, so going to another page closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const close = () => setOpenOn(null);

  return (
    <aside className={open ? 'docs-side is-open' : 'docs-side'}>
      <div className="docs-side-top">
        <button
          type="button"
          className="docs-search"
          aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'}
          onClick={() => setOpenSearch(true)}
        >
          <span>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            Search the docs
          </span>
          <kbd aria-hidden="true">{mac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <button
          type="button"
          className="docs-menu"
          aria-expanded={open}
          aria-controls={`${id}-nav`}
          onClick={() => setOpenOn(open ? null : pathname)}
        >
          {open ? 'Close' : 'Menu'}
        </button>
      </div>
      <nav id={`${id}-nav`} aria-label="Docs" className="docs-nav">
        {groups.map((group, index) => {
          const label = group.name ? `${id}-group-${index}` : undefined;
          return (
            <Fragment key={index}>
              {label ? (
                <span id={label} className="docs-group">
                  {group.name}
                </span>
              ) : null}
              <ul aria-labelledby={label}>
                {group.pages.map((page) => {
                  const current = page.url === pathname;
                  const subs = current ? sections[page.url] : undefined;
                  return (
                    <li key={page.url}>
                      <Link href={page.url} aria-current={current ? 'page' : undefined} onClick={close}>
                        {page.name}
                      </Link>
                      {subs?.length ? (
                        <ul>
                          {subs.map((section) => (
                            <li key={section.url}>
                              <a href={section.url} className="docs-sub" onClick={close}>
                                {/* One box, so the space before a heading's code survives the flex. */}
                                <span>{section.title}</span>
                              </a>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </Fragment>
          );
        })}
      </nav>
    </aside>
  );
}
