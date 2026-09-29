import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ImageResponse } from 'next/og';

import { Logo } from '@/components/logo';
import { BRAND } from './brand';

export const OG_SIZE = { width: 1200, height: 630 };

async function fonts() {
  const dir = join(process.cwd(), 'assets', 'fonts');
  const [sans, mono] = await Promise.all([
    readFile(join(dir, 'Geist-SemiBold.ttf')),
    readFile(join(dir, 'GeistMono-Medium.ttf')),
  ]);
  return [
    { name: 'Geist', data: sans, weight: 600 as const, style: 'normal' as const },
    { name: 'Geist Mono', data: mono, weight: 500 as const, style: 'normal' as const },
  ];
}

/** The social card for every page: cream type on the blue, like the home page. */
export async function renderOgImage({
  title,
  description,
  eyebrow,
}: {
  title: string;
  description?: string;
  eyebrow?: string;
}) {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '64px 72px',
        backgroundColor: BRAND.field,
        color: BRAND.cream,
        fontFamily: 'Geist',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Logo tone="field" width={48} height={48} />
        <div style={{ fontSize: 32, letterSpacing: -0.5 }}>Jev Events</div>
        {eyebrow && (
          <div style={{ display: 'flex', marginLeft: 12, fontFamily: 'Geist Mono', fontSize: 22, opacity: 0.7 }}>
            {`/ ${eyebrow}`}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        <div
          style={{
            display: 'flex',
            maxWidth: 1040,
            fontSize: title.length > 32 ? 80 : 104,
            lineHeight: 0.98,
            letterSpacing: title.length > 32 ? -3 : -4.5,
          }}
        >
          {title}
        </div>
        {description && (
          <div style={{ display: 'flex', maxWidth: 940, fontSize: 30, lineHeight: 1.35, opacity: 0.8 }}>
            {description}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', fontFamily: 'Geist Mono', fontSize: 22, opacity: 0.7 }}>jevevents.dev</div>
    </div>,
    { ...OG_SIZE, fonts: await fonts() },
  );
}
