import { renderOgImage, OG_SIZE } from '@/lib/og';
import { site } from '@/lib/site';

export const alt = `${site.name}: ${site.tagline}`;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage({
    title: site.tagline,
    description: 'An open-source TypeScript library built on TypeSafe’s Jev.',
    accent: ['typed', 'semantic'],
  });
}
