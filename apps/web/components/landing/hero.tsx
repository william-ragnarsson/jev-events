'use client';

// The hero is the product in use: the monitors console of a made-up app, Acme, with one lane per
// monitor. Items slide into Jev's playhead and light up with its verdict as they come out: green
// when they match nothing (they shrink to a thin tick), red when they match (they turn into the
// action that ran), and amber when the answer is borderline and waits for review. The counters
// count the crossings. The entrance is CSS (see [data-hero-*] in landing.css), so it starts with the
// first paint.
import gsap from 'gsap';
import { Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';

import { BRANDS } from './brands';
import { COPY, MORE_NOISE, QUESTIONS, STREAM, type SourceId, type StreamEvent } from './content';
import { InstallCommand } from './install';
import { copiesFor, lay, offsetFor, Track, useLoop, useWidth, watchCrossings, type Lane } from './loop';
import { QuickstartLink } from './ui';

/** Answers between the review and act thresholds (0.6 and 0.85): a person decides. */
const BORDERLINE: StreamEvent[] = [
  { id: 'r1', source: 'gmail', title: 'Quick question about the invoice', meta: 'ap@contoso.com', label: 'needs reply', p: 0.71, signal: false },
  { id: 'r2', source: 'slack', title: 'is anyone else seeing slow loads?', meta: '#support · Jo', label: 'bug report', p: 0.64, signal: false },
];
const EVENTS = new Map([...STREAM, ...MORE_NOISE, ...BORDERLINE].map((e) => [e.id, e]));
const REVIEW_AT = 0.6;

/** What Jev made of an item, which sets its colour: see --match, --no-match and --review in landing.css. */
type Verdict = 'match' | 'review' | 'none';

function verdictOf(e: StreamEvent | undefined): Verdict {
  if (e?.signal) return 'match';
  if (e && e.p >= REVIEW_AT) return 'review';
  return 'none';
}

/** The footer's counts when the page loads. `judged` is the sum of the other three. */
const START_COUNTS = { judged: 1284, none: 1273, match: 9, review: 2 };
const fmt = (n: number) => n.toLocaleString('en-US');

/** An item on a lane. Without `e`, it's a small untitled bit of noise. */
interface Item {
  source: SourceId;
  e?: StreamEvent;
}

/** One lane per monitor, in arrival order. "·" is a bit of untitled noise. */
const MONITORS: Array<{ source: SourceId; name: string; seq: string[] }> = [
  { source: 'gmail', name: 'Replies', seq: ['·', 'n1', '·', '·', 'e10', '·', 'e2', '·', '·', 'r1', '·', '·'] },
  { source: 'gcal', name: 'Invites', seq: ['n4', '·', '·', 'e1', '·', '·', 'e11', '·', '·'] },
  { source: 'slack', name: 'Bug reports', seq: ['·', 'n2', '·', '·', 'e3', '·', 'n12', '·', 'r2', '·', 'e12', '·'] },
  { source: 'outlook', name: 'Phishing', seq: ['·', 'e14', '·', '·', 'e5', '·', 'n3', '·', '·'] },
  { source: 'discord', name: 'Moderation', seq: ['n5', '·', '·', 'e15', '·', 'e8', '·', '·', '·'] },
  { source: 'drive', name: 'Data leaks', seq: ['n9', '·', 'e16', '·', '·', '·', 'e7', '·'] },
];
// Laid out right to left, so the lanes deliver items in `seq` order.
const LANES: Item[][] = MONITORS.map((m) =>
  m.seq.map((id): Item => (id === '·' ? { source: m.source } : { source: m.source, e: EVENTS.get(id)! })).reverse(),
);

const ROW_H = 56;
const BLOCK_H = 30;
const BIT_W = 22;
const GAPS = [16, 38, 22, 54, 14, 30, 64, 20, 44, 26];
const SPEEDS = [40, 33, 45, 37, 30, 42];
/** Where each lane's first match sits against the playhead at the start, as a share of its width past it. */
const START = [0.55, 1.7, -0.35, 0.3, 2.4, -1.1];
// "a question." never breaks apart.
const WORDS = ['Ask', 'every', 'event', 'a question.'];

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="mx-auto grid max-w-[1680px] items-center gap-12 px-6 pt-14 pb-16 md:px-12 md:pt-20 md:pb-24 xl:grid-cols-[440px_minmax(0,1fr)] xl:gap-16">
        <div>
          <h1 className="landing-display text-[clamp(3.3rem,6.6vw,6.9rem)]">
            {WORDS.map((w, i) => (
              <span key={i}>
                <span className="-my-[0.1em] inline-block overflow-hidden py-[0.1em] align-bottom">
                  <span data-hero-word className="inline-block" style={{ '--i': i } as CSSProperties}>
                    {w}
                  </span>
                </span>
                {i < WORDS.length - 1 && ' '}
              </span>
            ))}
          </h1>
          <p
            data-hero-fade
            className="mt-7 max-w-[430px] text-[17px] leading-[1.55] text-pretty text-[var(--muted)] md:text-[18px]"
            style={{ '--i': 0 } as CSSProperties}
          >
            {COPY.sub}
          </p>
          <div data-hero-fade className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-1" style={{ '--i': 1 } as CSSProperties}>
            <QuickstartLink />
            <InstallCommand />
          </div>
        </div>
        <Console />
      </div>
    </section>
  );
}

function Console() {
  const judged = useRef<HTMLSpanElement>(null);
  const none = useRef<HTMLSpanElement>(null);
  const match = useRef<HTMLSpanElement>(null);
  const review = useRef<HTMLSpanElement>(null);
  const reviewTab = useRef<HTMLSpanElement>(null);
  const counts = useRef({ ...START_COUNTS });

  const count = useCallback((e: StreamEvent | undefined) => {
    const c = counts.current;
    c.judged += 1;
    c[verdictOf(e)] += 1;
    const show = (el: HTMLSpanElement | null, n: number) => {
      if (el) el.textContent = fmt(n);
    };
    show(judged.current, c.judged);
    show(none.current, c.none);
    show(match.current, c.match);
    show(review.current, c.review);
    show(reviewTab.current, c.review);
  }, []);

  return (
    <div
      data-hero-console
      role="img"
      aria-label="An example monitors console for a made-up app, Acme. Emails, invites and messages slide into Jev one by one and light up as it judges them: green when they match nothing and are dropped, red when a monitor matches and runs its action, like accepting an invite, and amber when the answer is borderline and waits for a person to review it."
      className="landing-console relative flex min-w-0 flex-col overflow-hidden rounded-2xl xl:-mr-[260px]"
    >
      <div className="flex h-12 items-center gap-2.5 border-b border-[var(--line)] px-4 text-[13px]">
        <span className="grid size-6 place-items-center rounded-md bg-[#f97316] text-[11px] font-bold text-black">A</span>
        <span className="font-medium">Acme</span>
        <span className="text-[var(--dim)]">/</span>
        <span className="hidden text-[var(--muted)] sm:inline">production</span>
        <span className="hidden text-[var(--dim)] sm:inline">/</span>
        <span className="text-[var(--muted)]">Monitors</span>
        <span className="ml-3 flex items-center gap-1.5 font-mono text-[11px] text-[var(--muted)]">
          <span className="landing-live-dot size-1.5 rounded-full bg-[var(--accent)]" /> live
        </span>
        <span className="rounded-md border border-[var(--line-2)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--muted)]">dry-run</span>
      </div>
      <div className="flex h-10 items-end gap-6 border-b border-[var(--line)] px-4 text-[12.5px]">
        <span className="-mb-px border-b-2 border-[var(--accent)] pb-2.5">Live</span>
        <span className="pb-2.5 text-[var(--muted)]">
          Review
          <span ref={reviewTab} className="ml-1.5 rounded bg-white/[0.08] px-1.5 py-px font-mono text-[10.5px] tabular-nums">
            {fmt(START_COUNTS.review)}
          </span>
        </span>
        <span className="pb-2.5 text-[var(--muted)]">Actions</span>
        <span className="pb-2.5 text-[var(--muted)]">Connections</span>
      </div>
      <div className="grid grid-cols-[52px_minmax(0,1fr)] md:grid-cols-[236px_minmax(0,1fr)]">
        <Sidebar />
        <Timeline onCross={count} />
      </div>
      <div className="flex h-10 items-center gap-4 border-t border-[var(--line)] px-4 font-mono text-[11px] whitespace-nowrap text-[var(--dim)] sm:gap-5">
        <span className="hidden sm:inline">
          <span ref={judged} className="text-[var(--fg)] tabular-nums">
            {fmt(START_COUNTS.judged)}
          </span>{' '}
          judged today
        </span>
        <Tally ref={none} n={START_COUNTS.none} label="no match" color="var(--no-match)" />
        <Tally ref={match} n={START_COUNTS.match} label="acted" color="var(--match)" />
        <Tally ref={review} n={START_COUNTS.review} label="in review" color="var(--review)" />
      </div>
    </div>
  );
}

/** A footer count with a dot in its verdict's colour, so the footer doubles as the legend. */
function Tally({ ref, n, label, color }: { ref: Ref<HTMLSpanElement>; n: number; label: string; color: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className="size-1.5 rounded-full" style={{ background: color }} />
      <span>
        <span ref={ref} className="text-[var(--fg)] tabular-nums">
          {fmt(n)}
        </span>{' '}
        {label}
      </span>
    </span>
  );
}

function Sidebar() {
  return (
    <div className="border-r border-[var(--line)]">
      <div className="flex h-8 items-center border-b border-[var(--line)] px-4 font-mono text-[10px] tracking-[0.14em] text-[var(--dim)] uppercase">
        <span className="hidden md:inline">Monitor</span>
      </div>
      {MONITORS.map((m, i) => {
        const b = BRANDS[m.source];
        return (
          <div
            key={m.source}
            data-hero-row
            className="flex items-center gap-3 border-b border-[var(--line)] px-3 last:border-b-0 md:px-4"
            style={{ height: ROW_H, '--i': i } as CSSProperties}
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-md border border-[var(--line-2)] bg-white/[0.03]">
              <b.Icon aria-hidden className="size-3.5" style={{ color: b.color }} />
            </span>
            <div className="hidden min-w-0 md:block">
              <p className="truncate text-[12.5px] font-medium">{m.name}</p>
              <p className="truncate text-[11px] text-[var(--dim)]">{QUESTIONS[m.source]}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Timeline({ onCross }: { onCross: (e: StreamEvent | undefined) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  // The console runs off the right edge on wide screens; place the playhead in the part you can see.
  const [visible, setVisible] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || width === 0) return;
    const r = el.getBoundingClientRect();
    setVisible(Math.round(Math.min(r.width, document.documentElement.clientWidth - r.left)));
  }, [ref, width]);

  const mobile = visible > 0 && visible < 480;
  const playX = Math.round(visible * 0.44);
  const blockW = mobile ? 112 : 138;
  /** How far past the playhead the light fades out, in px. */
  const glow = mobile ? 90 : 150;
  const flashes = useRef<Array<HTMLDivElement | null>>([]);

  const lanes = useMemo<Lane<Item>[]>(() => {
    if (visible === 0) return [];
    return LANES.map((items, li) => {
      const { slots, period } = lay(
        items,
        (it) => (it.e ? blockW : BIT_W),
        (i) => GAPS[(i * 3 + li * 5) % GAPS.length]!,
      );
      const opener = slots.find((s) => s.item.e?.signal) ?? slots[0]!;
      return {
        slots,
        period,
        speed: SPEEDS[li]!,
        offset: offsetFor(opener, period, playX - opener.width * (1 - START[li]!)),
        copies: copiesFor(period, width),
      };
    });
  }, [visible, width, blockW, playX]);

  const onFrame = useMemo(() => {
    if (lanes.length === 0) return undefined;
    return watchCrossings(
      lanes,
      playX,
      (s) => s.width,
      (li, si) => {
        const e = lanes[li]!.slots[si]!.item.e;
        onCross(e);
        const flash = flashes.current[li];
        if (!flash) return;
        const verdict = verdictOf(e);
        flash.dataset.verdict = verdict;
        gsap.fromTo(flash, { opacity: 1 }, { opacity: 0, duration: verdict === 'none' ? 0.6 : 1.6, ease: 'power2.out', overwrite: true });
      },
    );
  }, [lanes, playX, onCross]);

  useLoop(ref, lanes, onFrame);

  return (
    <div ref={ref} className="relative min-w-0">
      <div className="relative h-8 border-b border-[var(--line)] font-mono text-[10px] tracking-[0.14em] text-[var(--dim)] uppercase">
        {visible > 0 && (
          <div className="landing-rise absolute inset-0">
            <span className="absolute top-1/2 left-4 -translate-y-1/2">Incoming</span>
            <span className="absolute top-1/2 -translate-y-1/2" style={{ left: playX + 18 }}>
              Judged
            </span>
            <span
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[4px] bg-[var(--accent)] px-1.5 py-0.5 tracking-normal text-[var(--accent-ink)] normal-case"
              style={{ left: playX }}
            >
              jev
            </span>
          </div>
        )}
      </div>
      <div data-hero-lanes className="landing-lanes relative" style={{ height: MONITORS.length * ROW_H }}>
        <div className="landing-judged-zone absolute inset-y-0 right-0" style={{ left: playX }} />
        <div className="absolute inset-0" style={{ clipPath: `inset(0 calc(100% - ${playX}px) 0 0)` }}>
          {lanes.map((lane, li) => (
            <Row key={li} li={li}>
              <Track lane={li} data={lane} render={(s, left, key) => <Incoming key={key} item={s.item} left={left} width={s.width} />} />
            </Row>
          ))}
        </div>
        <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${playX}px)` }}>
          {lanes.map((lane, li) => (
            <Row key={li} li={li}>
              <Track lane={li} data={lane} render={(s, left, key) => <Judged key={key} item={s.item} left={left} width={s.width} />} />
            </Row>
          ))}
        </div>
        {/* The lit copy on top starts at the playhead and fades out `glow` px past it. */}
        <div
          className="absolute inset-0"
          style={{
            maskImage: `linear-gradient(to right, transparent ${playX}px, #000 ${playX}px, #000 ${playX + 20}px, transparent ${playX + glow}px)`,
          }}
        >
          {lanes.map((lane, li) => (
            <Row key={li} li={li}>
              <Track lane={li} data={lane} render={(s, left, key) => <Lit key={key} item={s.item} left={left} width={s.width} />} />
            </Row>
          ))}
        </div>
        <div data-hero-play className="landing-playhead absolute inset-y-0 w-px origin-top" style={{ left: playX }} />
        {lanes.map((_, li) => (
          <div
            key={li}
            ref={(el) => {
              flashes.current[li] = el;
            }}
            className="landing-flash absolute w-[3px] -translate-x-1/2 rounded-full opacity-0"
            style={{ left: playX, top: li * ROW_H + (ROW_H - BLOCK_H) / 2 - 3, height: BLOCK_H + 6 }}
          />
        ))}
      </div>
    </div>
  );
}

function Row({ li, children }: { li: number; children: ReactNode }) {
  return (
    <div className="absolute inset-x-0" style={{ top: li * ROW_H + (ROW_H - BLOCK_H) / 2, height: BLOCK_H }}>
      {children}
    </div>
  );
}

interface ItemProps {
  item: Item;
  left: number;
  width: number;
  className?: string;
}

function Incoming({ item, left, width, className = '' }: ItemProps) {
  if (!item.e) return <div className={`landing-bit ${className} absolute inset-y-0 rounded-[5px]`} style={{ left, width }} />;
  return (
    <div className={`landing-item ${className} absolute inset-y-0 flex items-center rounded-md px-2.5`} style={{ left, width }}>
      <span className="truncate text-[11.5px]">{item.e.redacted ? <span className="landing-redacted" /> : item.e.title}</span>
    </div>
  );
}

function Judged({ item, left, width, className = '' }: ItemProps) {
  const e = item.e;
  const verdict = verdictOf(e);
  if (e && verdict === 'match') {
    return (
      <div className={`landing-hit ${className} absolute inset-y-0 flex items-center gap-1.5 rounded-md px-2`} style={{ left, width }}>
        <Zap className="size-3 shrink-0" />
        <span className="truncate text-[11.5px] font-medium">{e.action}</span>
      </div>
    );
  }
  if (e && verdict === 'review') {
    return (
      <div
        className={`landing-review ${className} absolute inset-y-0 flex items-center rounded-md px-2 font-mono text-[10.5px]`}
        style={{ left, width }}
      >
        <span className="truncate">
          review · {e.label} {e.p.toFixed(2)}
        </span>
      </div>
    );
  }
  // Noise shrinks to a tick at its leading edge, so it looks swallowed by the playhead.
  return <div className="landing-tick absolute inset-y-0 w-[2px] rounded-full" style={{ left: left + width - 2 }} />;
}

/** An item just past the playhead, lit in its verdict's colour. Noise lights up whole before it's a tick. */
function Lit(props: ItemProps) {
  return verdictOf(props.item.e) === 'none' ? <Incoming {...props} className="landing-lit" /> : <Judged {...props} className="landing-lit" />;
}
