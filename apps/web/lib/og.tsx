import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ImageResponse } from 'next/og';

export const OG_SIZE = { width: 1200, height: 630 };

// The dark theme's colors, in hex because the image renderer doesn't read oklch.
const SIGNAL = '#c0f84f';
const MUTED = '#a3a3a3';
const FAINT = '#737373';

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

const CHIPS = [
  { label: 'kind:question', color: '#7dd3fc' },
  { label: 'kind:hype', color: '#fcd34d' },
  { label: 'hateful', color: '#fca5a5' },
];

/**
 * The social card for every page. `accent` words of the title are drawn in the signal color.
 */
export async function renderOgImage({
  title,
  description,
  eyebrow,
  accent = [],
}: {
  title: string;
  description?: string;
  eyebrow?: string;
  accent?: string[];
}) {
  const words = title.split(' ');
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '64px 72px',
        backgroundColor: '#050505',
        backgroundImage: 'radial-gradient(circle at 88% -10%, rgba(192, 248, 79, 0.18), transparent 55%)',
        color: '#fafafa',
        fontFamily: 'Geist',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <svg width="52" height="52" viewBox="0 0 32 32">
          <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="#0a0a0a" stroke="#262626" />
          <rect x="7" y="8.5" width="11" height="3" rx="1.5" fill="#fafafa" opacity="0.55" />
          <rect x="7" y="14.5" width="18" height="3" rx="1.5" fill={SIGNAL} />
          <rect x="7" y="20.5" width="8" height="3" rx="1.5" fill="#fafafa" opacity="0.55" />
        </svg>
        <div style={{ fontSize: 34, letterSpacing: -0.5 }}>Jev Events</div>
        {eyebrow && (
          <div style={{ display: 'flex', marginLeft: 14, fontFamily: 'Geist Mono', fontSize: 22, color: FAINT }}>
            {`/ ${eyebrow}`}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', maxWidth: 1000, fontSize: title.length > 40 ? 72 : 84, lineHeight: 1.06, letterSpacing: -2.5 }}>
          {words.map((word, index) => (
            <span
              key={index}
              style={{ marginRight: 16, color: accent.includes(word.replace(/[.,]$/, '')) ? SIGNAL : '#fafafa' }}
            >
              {word}
            </span>
          ))}
        </div>
        {description && (
          <div style={{ display: 'flex', maxWidth: 940, fontSize: 30, lineHeight: 1.35, color: MUTED }}>{description}</div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontFamily: 'Geist Mono', fontSize: 22 }}>
        <div style={{ display: 'flex', color: FAINT }}>jevevents.dev</div>
        <div style={{ display: 'flex', gap: 12 }}>
          {CHIPS.map((chip) => (
            <div
              key={chip.label}
              style={{
                display: 'flex',
                padding: '6px 14px',
                borderRadius: 10,
                border: `1.5px solid ${chip.color}55`,
                backgroundColor: `${chip.color}14`,
                color: chip.color,
              }}
            >
              {chip.label}
            </div>
          ))}
        </div>
      </div>
    </div>,
    { ...OG_SIZE, fonts: await fonts() },
  );
}
