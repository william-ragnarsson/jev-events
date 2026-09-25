import { HomeLayout } from 'fumadocs-ui/layouts/home';

import { SiteFooter } from '@/components/home/sections';
import { baseOptions } from '@/lib/layout.shared';

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <>
      <HomeLayout {...baseOptions()}>{children}</HomeLayout>
      <SiteFooter />
    </>
  );
}
