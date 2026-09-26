'use client';

// "How it works": one calendar invite through a monitor, in six steps. On large screens the section
// pins, and scrolling walks through the code with the invite beside it. On small or short screens,
// and for reduced motion, the steps stack as cards instead.
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Check } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import { GoogleCalendarIcon } from '../brand-icons';
import { BRANDS } from './brands';
import { CodeLines } from './code-lines';
import { STORY, STORY_ANSWER, STORY_CODE, STORY_INVITE } from './content';
import { H2, Kicker } from './ui';

gsap.registerPlugin(ScrollTrigger, useGSAP);

/** When the walkthrough pins. Keep in step with the lg:[@media(min-height:640px)] classes below. */
const PINNED = '(min-width: 1024px) and (min-height: 640px) and (prefers-reduced-motion: no-preference)';

export function Story() {
  const [step, setStep] = useState(0);
  const root = useRef<HTMLElement>(null);
  const pin = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const fills = useRef<Array<HTMLElement | null>>([]);
  const trigger = useRef<ScrollTrigger | null>(null);

  useGSAP(
    () => {
      gsap.matchMedia().add(PINNED, () => {
        trigger.current = ScrollTrigger.create({
          trigger: pin.current,
          start: 'top top',
          end: () => `+=${Math.round(window.innerHeight * STORY.length * 0.7)}`,
          pin: true,
          scrub: true,
          onUpdate: (self) => {
            const scaled = self.progress * STORY.length;
            setStep(Math.min(STORY.length - 1, Math.floor(scaled)));
            fills.current.forEach((f, i) => {
              if (f) f.style.transform = `scaleX(${Math.max(0, Math.min(1, scaled - i))})`;
            });
          },
        });
        return () => {
          trigger.current = null;
        };
      });
    },
    { scope: root },
  );
  useFit(box, content);

  /** Scrolls to the middle of step i's stretch of the pin. */
  const goTo = (i: number) => {
    const st = trigger.current;
    if (!st) return;
    window.scrollTo({ top: st.start + ((st.end - st.start) * (i + 0.5)) / STORY.length, behavior: 'smooth' });
  };

  const inlays = step >= 3 ? answerInlays() : {};

  return (
    <section ref={root} id="how" className="relative scroll-mt-14">
      <div className="mx-auto max-w-7xl px-6 pt-28 pb-10 lg:[@media(min-height:640px)]:pb-0">
        <div data-reveal>
          <Kicker>How it works</Kicker>
          <h2 className={`mt-4 max-w-3xl ${H2}`}>One calendar invite, step by step.</h2>
          <p className="mt-5 max-w-2xl text-[16px] leading-relaxed text-pretty text-[var(--muted)]">
            Say you&apos;re building Acme, an assistant that looks after people&apos;s calendars. You want it to accept the meetings that
            matter and tell the person why. Here&apos;s the whole monitor, and what happens when one invite arrives.
          </p>
        </div>
      </div>

      <div ref={pin} data-story-pin className="relative hidden h-screen lg:[@media(min-height:640px)]:block">
        <div
          ref={box}
          className="mx-auto flex h-full max-w-7xl flex-col justify-center-safe px-6 pt-[88px] pb-8 [@media(max-height:860px)]:pt-[72px] [@media(max-height:860px)]:pb-6"
        >
          <div ref={content} className="origin-top">
            <ol className="grid grid-cols-6 gap-3">
              {STORY.map((st, i) => (
                <li key={st.id}>
                  <button
                    type="button"
                    onClick={() => goTo(i)}
                    aria-current={i === step ? 'step' : undefined}
                    className="group block w-full pb-1 text-left"
                  >
                    <span className="relative block h-px overflow-hidden bg-[var(--line-2)]">
                      <span
                        ref={(el) => {
                          fills.current[i] = el;
                        }}
                        className="absolute inset-0 origin-left bg-[var(--accent)]"
                        style={{ transform: 'scaleX(0)' }}
                      />
                    </span>
                    <span
                      className={`mt-3 block font-mono text-[11px] tracking-[0.12em] uppercase transition-colors duration-300 ${
                        i === step ? 'text-[var(--accent)]' : i < step ? 'text-[var(--muted)]' : 'text-[var(--dim)] group-hover:text-[var(--muted)]'
                      }`}
                    >
                      0{i + 1} · {st.kicker}
                    </span>
                  </button>
                </li>
              ))}
            </ol>

            {/* Every step's text sits in the same cell, so the row is as tall as the longest one and the
                code below doesn't jump as the steps change. */}
            <div className="mt-7 grid [@media(max-height:860px)]:mt-5">
              {STORY.map((st, i) => (
                <div
                  key={st.id}
                  aria-hidden={i !== step}
                  className={`col-start-1 row-start-1 grid grid-cols-12 gap-6 ${i === step ? 'landing-rise' : 'invisible'}`}
                >
                  <h3 className="col-span-5 text-[28px] leading-tight font-semibold tracking-[-0.02em] text-balance [@media(max-height:860px)]:text-[24px]">
                    {st.title}
                  </h3>
                  <p className="col-span-6 col-start-7 text-[15px] leading-relaxed text-[var(--muted)] [@media(max-height:860px)]:text-[14px]">
                    {prose(st.body)}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-7 grid grid-cols-12 gap-6 [@media(max-height:860px)]:mt-5">
              <div className="col-span-7 min-w-0 overflow-hidden rounded-2xl border border-[var(--line-2)] bg-[var(--panel)] shadow-[0_30px_80px_-30px_rgb(0_0_0/0.9)]">
                <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-2.5">
                  <span className="size-2.5 rounded-full bg-white/10" />
                  <span className="size-2.5 rounded-full bg-white/10" />
                  <span className="size-2.5 rounded-full bg-white/10" />
                  <span className="ml-3 font-mono text-[12px] text-[var(--muted)]">invites.ts</span>
                  <span className="ml-auto font-mono text-[11px] text-[var(--dim)]">TypeScript</span>
                </div>
                <CodeLines
                  code={STORY_CODE}
                  active={STORY[step]!.lines}
                  inlays={inlays}
                  className="overflow-hidden py-3 pr-4 font-mono text-[11px] leading-[1.55] [@media(min-height:861px)]:leading-[1.7] xl:[@media(min-height:861px)]:text-[12px]"
                  lineClassName="pl-2"
                  activeClassName="landing-line-on"
                />
              </div>
              <div className="col-span-5">
                <Stage step={step} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div data-story-stack className="mx-auto max-w-5xl space-y-4 px-6 pb-4 lg:[@media(min-height:640px)]:hidden">
        {STORY.map((s, i) => {
          const [from, to] = s.excerpt;
          return (
            <article
              key={s.id}
              data-reveal
              className="grid gap-6 rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5 md:grid-cols-2 md:gap-8 md:p-7"
            >
              <div>
                <p className="font-mono text-[11px] tracking-[0.12em] text-[var(--accent)] uppercase">
                  0{i + 1} · {s.kicker}
                </p>
                <h3 className="mt-2 text-xl font-semibold tracking-tight text-balance">{s.title}</h3>
                <p className="mt-2 text-[14.5px] leading-relaxed text-[var(--muted)]">{prose(s.body)}</p>
              </div>
              <div className="min-w-0 space-y-4">
                <CodeLines
                  code={excerpt(from, to)}
                  lineNumbers={false}
                  active={to > from ? s.lines.map((n) => n - from + 1) : []}
                  dimOpacity={0.45}
                  wrap
                  className="rounded-lg border border-[var(--line)] bg-black/30 py-2.5 font-mono text-[11.5px] leading-[1.65]"
                  lineClassName="px-3"
                  activeClassName="landing-line-on"
                />
                {s.id === 'context' && <InviteCard step={1} />}
                <StepVisual step={i} />
                {s.id === 'action' && <AcmeToast />}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Scales the pinned walkthrough down when it doesn't fit the screen, so the code is never cut off.
 * Most laptop screens fit it as is, with the tighter sizes for short screens above.
 */
function useFit(box: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const outer = box.current;
    const inner = content.current;
    if (!outer || !inner) return;
    const fit = () => {
      if (outer.clientHeight === 0 || inner.offsetHeight === 0) return;
      const style = getComputedStyle(outer);
      const room = outer.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const scale = Math.min(1, room / inner.offsetHeight);
      inner.style.transform = scale < 1 ? `scale(${scale.toFixed(3)})` : '';
    };
    const observer = new ResizeObserver(fit);
    observer.observe(outer);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [box, content]);
}

/** Lines `from` to `to` of the walkthrough code, dedented, for the stacked steps. */
function excerpt(from: number, to: number) {
  const lines = STORY_CODE.split('\n').slice(from - 1, to);
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return lines.map((l) => l.slice(indent)).join('\n');
}

/** Renders `code` in a step's text. */
function prose(text: string): ReactNode {
  return text.split('`').map((part, i) =>
    i % 2 ? (
      <code key={i} className="font-mono text-[0.92em] text-[var(--fg)]">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

/** Jev's answer next to each choice label in the monitor's code. */
function answerInlays() {
  return Object.fromEntries(
    Object.entries(STORY_ANSWER).map(([n, a]) => [
      Number(n),
      <span
        key={n}
        className="landing-rise ml-4 rounded px-1.5 py-px font-mono text-[0.95em]"
        style={
          a.label === 'critical'
            ? { background: 'color-mix(in oklab, var(--accent) 16%, transparent)', color: 'var(--accent)' }
            : { color: 'var(--dim)' }
        }
      >
        {a.p.toFixed(2)}
      </span>,
    ]),
  );
}

function Stage({ step }: { step: number }) {
  return (
    <div className="relative h-full rounded-2xl border border-[var(--line)] bg-[radial-gradient(120%_80%_at_100%_0%,rgb(255_255_255/0.04),transparent_60%)] p-5">
      <InviteCard step={step} />
      <div key={step} className="landing-rise mt-4">
        <StepVisual step={step} />
      </div>
      {step === STORY.length - 1 && <AcmeToast className="absolute -top-6 -right-6 w-[290px]" />}
    </div>
  );
}

function StepVisual({ step }: { step: number }) {
  switch (STORY[step]!.id) {
    case 'source':
      return (
        <ul className="space-y-2 font-mono text-[11.5px] text-[var(--muted)]">
          {['dana@acme.com connected with your OAuth app', 'Watching for new and changed invites', 'Picks up where it left off after a restart'].map(
            (t) => (
              <li key={t} className="flex items-center gap-2">
                <Check className="size-3.5 shrink-0 text-[var(--accent)]" /> {t}
              </li>
            ),
          )}
        </ul>
      );
    case 'context':
      return (
        <ul className="space-y-2 text-[12.5px] text-[var(--muted)]">
          <li className="flex items-center gap-2.5">
            <span className="size-2.5 rounded-[3px] border border-[var(--line-2)] bg-white/[0.06]" /> Worked out by the integration
          </li>
          <li className="flex items-center gap-2.5">
            <span className="size-2.5 rounded-[3px] border border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_22%,transparent)]" />{' '}
            From your profile function
          </li>
        </ul>
      );
    case 'question':
      return (
        <div>
          <div className="rounded-xl rounded-tl-sm border border-[var(--line-2)] bg-white/[0.04] px-4 py-3 text-[14px]">
            How important is this meeting to this person?
          </div>
          <div className="mt-3 flex gap-2 font-mono text-[11px]">
            {['critical', 'useful', 'skip'].map((l) => (
              <span key={l} className="rounded-md border border-[var(--line)] px-2 py-1 text-[var(--muted)]">
                {l}
              </span>
            ))}
          </div>
        </div>
      );
    case 'judgment':
      return (
        <div>
          {Object.values(STORY_ANSWER).map((a) => (
            <div key={a.label} className="mb-2.5">
              <div className="mb-1 flex justify-between font-mono text-[11px]">
                <span className={a.label === 'critical' ? 'text-[var(--fg)]' : 'text-[var(--muted)]'}>{a.label}</span>
                <span className={a.label === 'critical' ? 'text-[var(--accent)]' : 'text-[var(--dim)]'}>{a.p.toFixed(2)}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className="landing-grow h-full rounded-full"
                  style={{ width: `${a.p * 100}%`, background: a.label === 'critical' ? 'var(--accent)' : 'rgb(255 255 255 / 0.25)' }}
                />
              </div>
            </div>
          ))}
          <p className="mt-3 flex justify-between font-mono text-[10.5px] text-[var(--dim)]">
            <span>{STORY_INVITE.latencyMs} ms</span>
            <span>example numbers</span>
          </p>
        </div>
      );
    case 'policy':
      return <Threshold />;
    case 'action':
      return (
        <ul className="space-y-2 font-mono text-[11.5px]">
          <li className="flex items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2">
            <span className="shrink-0 text-[var(--dim)]">native</span>
            <span className="truncate">calendar.respond(&quot;accepted&quot;)</span>
            <Check className="ml-auto size-3.5 shrink-0 text-[var(--accent)]" />
          </li>
          <li className="flex items-center gap-2 rounded-lg border border-[color-mix(in_oklab,var(--accent)_40%,transparent)] px-3 py-2">
            <span className="shrink-0 text-[var(--dim)]">your code</span>
            <span className="truncate">notify(e.connection, e.item)</span>
            <Check className="ml-auto size-3.5 shrink-0 text-[var(--accent)]" />
          </li>
        </ul>
      );
  }
}

function InviteCard({ step }: { step: number }) {
  const withFacts = step >= 1;
  return (
    <div className="rounded-xl border border-[var(--line-2)] bg-[var(--panel-2)] p-4 shadow-[0_20px_50px_-20px_rgb(0_0_0/0.9)]">
      <div className="flex items-center gap-2 text-[11px] text-[var(--muted)]">
        <GoogleCalendarIcon aria-hidden className="size-3.5" style={{ color: BRANDS.gcal.color }} />
        New invite
        <span className="ml-auto truncate font-mono text-[10px] text-[var(--dim)]">to dana@acme.com</span>
      </div>
      <p className="mt-3 text-[17px] font-semibold tracking-tight">{STORY_INVITE.title}</p>
      <p className="mt-0.5 text-[12.5px] text-[var(--muted)]">{STORY_INVITE.when}</p>
      <div className="mt-3 flex items-center gap-2 text-[12.5px]">
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-[#2b3a55] text-[9px] font-semibold">SC</span>
        {STORY_INVITE.organizer}
        <span className="text-[var(--dim)]">· {STORY_INVITE.organizerRole}</span>
        <span className="ml-auto shrink-0 text-[11.5px] text-[var(--dim)]">{STORY_INVITE.guests} guests</span>
      </div>
      <div className="grid transition-[grid-template-rows] duration-500" style={{ gridTemplateRows: withFacts ? '1fr' : '0fr' }}>
        <div className="overflow-hidden">
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-[var(--line)] pt-3">
            {STORY_INVITE.facts.map((f, i) => (
              <span
                key={f.k}
                className={`rounded-md border px-2 py-1 font-mono text-[10.5px] transition-[opacity,transform] duration-500 ${
                  f.from === 'profile'
                    ? 'border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]'
                    : 'border-[var(--line)] bg-white/[0.02]'
                }`}
                style={{
                  opacity: withFacts ? 1 : 0,
                  transform: withFacts ? 'none' : 'translateY(6px)',
                  transitionDelay: `${i * 80 + 150}ms`,
                }}
              >
                <span className="text-[var(--dim)]">{f.k}</span> {f.v}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Threshold() {
  const p = STORY_ANSWER[9]!.p;
  return (
    <div className="pt-2">
      <div className="relative h-2 rounded-full bg-white/[0.06]">
        <div className="absolute inset-y-0 left-[60%] w-[25%] bg-white/[0.12]" />
        <div className="absolute inset-y-0 right-0 left-[85%] rounded-r-full bg-[color-mix(in_oklab,var(--accent)_55%,transparent)]" />
        <div
          className="landing-rise absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--bg)] bg-[var(--accent)] shadow-[0_0_0_4px_color-mix(in_oklab,var(--accent)_25%,transparent)]"
          style={{ left: `${p * 100}%`, animationDelay: '200ms' }}
        />
      </div>
      <div className="relative mt-3 h-8 font-mono text-[10.5px] text-[var(--dim)]">
        <span className="absolute left-0">ignore</span>
        <span className="absolute left-[60%] -translate-x-1/2">review 0.6</span>
        <span className="absolute left-[85%] -translate-x-1/2 text-[var(--accent)]">act 0.85</span>
      </div>
      <p className="font-mono text-[11.5px]">
        critical <span className="text-[var(--accent)]">{p.toFixed(2)}</span> <span className="text-[var(--dim)]">→</span> act
      </p>
    </div>
  );
}

function AcmeToast({ className = '' }: { className?: string }) {
  return (
    <div
      className={`landing-rise rounded-xl border border-[var(--line-2)] bg-[#15171c]/95 p-3.5 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)] backdrop-blur ${className}`}
      style={{ animationDelay: '250ms' }}
    >
      <div className="flex items-center gap-2">
        <span className="grid size-5 place-items-center rounded-md bg-[#f97316] text-[10px] font-bold text-black">A</span>
        <span className="text-[12px] font-medium">Acme</span>
        <span className="ml-auto text-[11px] text-[var(--dim)]">now</span>
      </div>
      <p className="mt-2 text-[13px] leading-snug">
        Sarah Chen (CEO) invited you to <span className="font-semibold">Q4 planning</span>.
      </p>
      <p className="mt-1 text-[12px] text-[var(--muted)]">Looks critical, so it&apos;s on your calendar.</p>
    </div>
  );
}
