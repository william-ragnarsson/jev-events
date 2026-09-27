// The landing page's plainer sections: the logo strip, why Jev, the integrations and the way in.
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import type { CSSProperties } from 'react';

import { site } from '@/lib/site';
import { BRANDS } from './brands';
import { INTEGRATIONS, JEV_FACTS } from './content';
import { SpotlightGrid } from './spotlight';
import { H2, Kicker, QuickstartLink, TryLink } from './ui';
import { WaitlistForm } from './waitlist';

export function Logos() {
  return (
    <section aria-label="Integrations" className="border-y border-[var(--line)] bg-white/[0.012]">
      <div className="mx-auto max-w-7xl px-6 py-10">
        <p className="text-center text-[13px] text-[var(--muted)]">Ready-made integrations for the apps your users already use.</p>
        <ul className="mt-8 grid grid-cols-4 gap-y-7 sm:grid-cols-6 lg:grid-cols-12">
          {INTEGRATIONS.map(({ id }) => {
            const b = BRANDS[id];
            return (
              <li key={id} className="group flex flex-col items-center gap-2.5 text-center" style={{ '--brand': b.color } as CSSProperties}>
                <b.Icon aria-hidden className="size-[22px] text-[var(--dim)] transition-colors duration-300 group-hover:text-[var(--brand)]" />
                <span className="px-1 text-[11px] leading-tight text-[var(--dim)] transition-colors group-hover:text-[var(--muted)]">{b.name}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

export function WhyJev() {
  return (
    <section className="mx-auto max-w-7xl px-6 py-28">
      <div className="grid gap-12 lg:grid-cols-[1fr_1.35fr] lg:gap-16">
        <div data-reveal>
          <Kicker>Why Jev</Kicker>
          <h2 className={`mt-4 ${H2}`}>Fast and cheap enough to ask about everything.</h2>
          <p className="mt-5 max-w-md text-[15.5px] leading-relaxed text-pretty text-[var(--muted)]">
            Sending every email to a large chat model is slow and expensive, and you get back text you still have to parse. Jev is made
            for short questions like the one above. It answers in milliseconds and gives you a probability you can set a threshold on.
          </p>
        </div>
        <div
          data-reveal
          className="grid grid-cols-1 divide-y divide-[var(--line)] self-end border-y border-[var(--line)] sm:grid-cols-3 sm:divide-x sm:divide-y-0"
        >
          {JEV_FACTS.map((f) => (
            <div key={f.label} className="py-8 sm:px-6 sm:py-9 sm:first:pl-0">
              <p className="text-[clamp(2.1rem,3.6vw,3rem)] leading-none font-semibold tracking-[-0.03em]">{f.value}</p>
              <p className="mt-3 text-[14px] text-[var(--muted)]">{f.label}</p>
              <p className="mt-6 font-mono text-[11px] text-[var(--dim)] sm:mt-8">{f.note}</p>
            </div>
          ))}
        </div>
      </div>
      <p className="mt-6 text-[12px] text-[var(--dim)]">
        Speed and price are{' '}
        <a href={site.typesafeDocs} className="underline decoration-[var(--line-2)] underline-offset-4 transition-colors hover:text-[var(--muted)]">
          TypeSafe&apos;s published figures
        </a>
        . The scores in the walkthrough above are made up for the example.
      </p>
    </section>
  );
}

export function Integrations() {
  const Webhook = BRANDS.webhook.Icon;
  return (
    <section id="integrations" className="mx-auto max-w-7xl scroll-mt-14 px-6 pb-28">
      <div data-reveal className="flex flex-wrap items-end justify-between gap-x-12 gap-y-6">
        <div>
          <Kicker>Integrations</Kicker>
          <h2 className={`mt-4 ${H2}`}>
            Twelve integrations.
            <br />
            <span className="text-[var(--muted)]">No API docs to read.</span>
          </h2>
        </div>
        <p className="max-w-md text-[15px] leading-relaxed text-pretty text-[var(--muted)]">
          Each integration already deals with the platform&apos;s API, so you don&apos;t have to learn how to fetch new items, refresh tokens
          or stay under rate limits. It also comes with the actions you&apos;d want, like accepting an invite or moving an email to Junk.{' '}
          <span className="whitespace-nowrap">Sign-in</span> goes through your own OAuth app, and the tokens stay in your database.
        </p>
      </div>
      <SpotlightGrid className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--line)] sm:grid-cols-2 lg:grid-cols-4">
        {INTEGRATIONS.map((item) => {
          const b = BRANDS[item.id];
          return (
            <div key={item.id} data-spot className="landing-spot flex flex-col p-6">
              <div className="flex items-center gap-3">
                <span className="grid size-9 place-items-center rounded-lg border border-[var(--line-2)] bg-white/[0.02]">
                  <b.Icon aria-hidden className="size-[18px]" style={{ color: b.color }} />
                </span>
                <h3 className="font-medium">{b.name}</h3>
              </div>
              <p className="mt-4 text-[13px] leading-snug text-[var(--muted)]">
                <span className="text-[var(--dim)]">Watches</span> {item.watches}
              </p>
              <p className="sr-only">Actions:</p>
              <ul className="mt-4 flex flex-wrap gap-1.5 pt-0.5">
                {item.actions.map((a) => (
                  <li key={a} className="rounded-md border border-[var(--line)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--muted)]">
                    {a}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </SpotlightGrid>
      <div
        data-reveal
        className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-dashed border-[var(--line-2)] px-6 py-5"
      >
        <p className="flex items-start gap-3 text-[14px] leading-relaxed text-[var(--muted)]">
          <Webhook aria-hidden className="mt-[3px] size-4 shrink-0 text-[var(--fg)]" />
          <span>
            Using something else? Send items in with <code className="font-mono text-[0.92em] text-[var(--fg)]">webhook()</code> or{' '}
            <code className="font-mono text-[0.92em] text-[var(--fg)]">from(asyncIterable)</code>.
          </span>
        </p>
        <Link href="/docs/integrations/custom" className="group inline-flex items-center gap-1.5 text-[13px] text-[var(--fg)]">
          Custom sources <ArrowRight className="size-3.5 transition-transform duration-300 group-hover:translate-x-0.5" />
        </Link>
      </div>
    </section>
  );
}

export function Closing() {
  return (
    <section className="mx-auto max-w-7xl px-6 pb-28">
      <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
        <div data-reveal className="flex flex-col rounded-3xl border border-[var(--line)] bg-[var(--panel)] p-8 md:p-12">
          <h2 className={H2}>
            Ask your first question
            <br />
            in five minutes.
          </h2>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-pretty text-[var(--muted)]">
            It&apos;s an open-source TypeScript library under the MIT license. Monitors start in dry-run, so you can point one at a real
            account without it changing anything.
          </p>
          <div className="mt-auto flex flex-wrap items-center gap-3 pt-9">
            <QuickstartLink />
            <TryLink />
          </div>
        </div>
        <WaitlistForm />
      </div>
    </section>
  );
}
