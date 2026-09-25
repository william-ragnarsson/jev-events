import {
  ArrowRight,
  Braces,
  Eye,
  FlaskConical,
  Gauge,
  Hourglass,
  Receipt,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Terminal,
  UserCheck,
  Webhook,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import type { ComponentType, ReactNode, SVGProps } from 'react';

import dataset from '@/generated/dataset.json';
import recipes from '@/generated/recipes.json';
import relay from '@/generated/relay.json';
import snippets from '@/generated/snippets.json';
import { headlineRun, percent, type BenchmarkRun } from '@/lib/benchmarks';
import { cn } from '@/lib/cn';
import { site } from '@/lib/site';
import { DiscordIcon, GitHubIcon, GmailIcon, GoogleCalendarIcon, TwitchIcon, YouTubeIcon } from '../brand-icons';
import { Code } from '../code';
import { InstallCommand } from '../install-command';
import { LabelChip } from '../live-feed';
import { Logo } from '../logo';

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Section({
  id,
  eyebrow,
  title,
  lead,
  children,
  className,
}: {
  id?: string;
  eyebrow: string;
  title: ReactNode;
  lead?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cn('mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-16 sm:px-6 md:py-24', className)}>
      <div className="max-w-2xl">
        <p className="font-mono text-xs font-medium tracking-widest text-signal uppercase">{eyebrow}</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance md:text-4xl">{title}</h2>
        {lead && <p className="mt-4 text-lg text-pretty text-fd-muted-foreground">{lead}</p>}
      </div>
      <div className="mt-12">{children}</div>
    </section>
  );
}

function ButtonLink({
  href,
  children,
  variant = 'primary',
  external,
}: {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
  external?: boolean;
}) {
  const className = cn(
    'inline-flex h-11 items-center justify-center gap-2 rounded-lg px-5 text-sm font-medium transition-colors',
    variant === 'primary'
      ? 'bg-fd-primary text-fd-primary-foreground hover:bg-fd-primary/85'
      : 'border bg-fd-card hover:bg-fd-accent',
  );
  return external ? (
    <a href={href} className={className} target="_blank" rel="noreferrer">
      {children}
    </a>
  ) : (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

function InlineCode({ children }: { children: ReactNode }) {
  return <code className="rounded-md border bg-fd-secondary/60 px-1.5 py-0.5 font-mono text-[0.8em]">{children}</code>;
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

export function Hero({ feed }: { feed: ReactNode }) {
  return (
    <section className="relative isolate overflow-x-clip">
      <div aria-hidden className="bg-grid absolute inset-x-0 top-0 -z-10 h-[720px]" />
      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 items-center gap-14 px-4 pt-14 pb-16 sm:px-6 md:pt-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-12 lg:pb-24">
        <div>
          <a
            href={site.typesafeDocs}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-full border bg-fd-card/70 px-3 py-1 text-xs text-fd-muted-foreground backdrop-blur transition-colors hover:text-fd-foreground"
          >
            <span className="size-1.5 rounded-full bg-signal" />
            Built on TypeSafe&apos;s Jev
            <ArrowRight className="size-3" />
          </a>
          <h1 className="mt-6 text-[2.6rem] leading-[1.05] font-semibold tracking-tighter text-balance sm:text-6xl">
            Turn any stream into <span className="text-signal">typed, semantic</span> events.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-pretty text-fd-muted-foreground">
            Point Jev Events at a chat, an inbox or any feed, ask a question in plain language, and handle every
            answer with a built-in moderation action or your own code. Sockets, logins, rate limits and safety rails
            are done for you.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <InstallCommand command="npm i jev-events" />
            <ButtonLink href="/docs/quickstart">
              Get started <ArrowRight className="size-4" />
            </ButtonLink>
          </div>
          <ul className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-sm text-fd-muted-foreground">
            {['Open source, MIT', 'TypeScript-first', 'Dry-run by default', 'Official APIs only'].map((item) => (
              <li key={item} className="flex items-center gap-2">
                <span className="size-1 rounded-full bg-fd-muted-foreground/60" />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div id="live" className="scroll-mt-24">
          {feed}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

type Icon = ComponentType<SVGProps<SVGSVGElement>> | LucideIcon;

const INTEGRATIONS: Array<{
  name: string;
  icon: Icon;
  color?: string;
  available: boolean;
  what: string;
  actions: string[];
  href?: string;
}> = [
  {
    name: 'Twitch',
    icon: TwitchIcon,
    color: '#9146FF',
    available: true,
    what: 'Live chat, signed in or read-only',
    actions: ['timeout', 'ban', 'delete', 'warn', 'reply', 'clip'],
    href: '/docs/integrations/twitch',
  },
  {
    name: 'YouTube',
    icon: YouTubeIcon,
    color: '#FF0000',
    available: false,
    what: 'Live chat and video comments',
    actions: ['delete', 'ban', 'hold for review', 'reply'],
  },
  {
    name: 'Discord',
    icon: DiscordIcon,
    color: '#5865F2',
    available: false,
    what: 'Messages in your server',
    actions: ['delete', 'timeout', 'kick', 'react', 'mod log'],
  },
  {
    name: 'Gmail',
    icon: GmailIcon,
    color: '#EA4335',
    available: false,
    what: 'New mail as it lands',
    actions: ['label', 'archive', 'star', 'mark read'],
  },
  {
    name: 'Google Calendar',
    icon: GoogleCalendarIcon,
    color: '#4285F4',
    available: false,
    what: 'New and upcoming events',
    actions: ['accept', 'decline', 'maybe'],
  },
  {
    name: 'Anything else',
    icon: Webhook,
    available: true,
    what: 'Async iterables, webhooks, your own source',
    actions: ['your code'],
    href: '/docs/integrations/custom',
  },
];

export function Integrations() {
  return (
    <Section
      id="integrations"
      eyebrow="Sources"
      title="The streams people actually moderate."
      lead="Every connector uses the platform's official API with your own credentials, in your own app. Nothing is scraped, and nothing runs on our servers."
    >
      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border bg-fd-border sm:grid-cols-2 lg:grid-cols-3">
        {INTEGRATIONS.map((integration) => {
          const Icon = integration.icon;
          const body = (
            <>
              <div className="flex items-center justify-between">
                <Icon className="size-6" style={integration.color ? { color: integration.color } : undefined} />
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 font-mono text-[10px] font-medium tracking-wide uppercase',
                    integration.available
                      ? 'bg-signal-soft text-signal'
                      : 'bg-fd-secondary text-fd-muted-foreground',
                  )}
                >
                  {integration.available ? 'Available' : 'In development'}
                </span>
              </div>
              <h3 className="mt-5 font-semibold">{integration.name}</h3>
              <p className="mt-1 text-sm text-fd-muted-foreground">{integration.what}</p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {integration.actions.map((action) => (
                  <span key={action} className="rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-fd-muted-foreground">
                    {action}
                  </span>
                ))}
              </div>
            </>
          );
          return integration.href ? (
            <Link key={integration.name} href={integration.href} className="bg-fd-card p-6 transition-colors hover:bg-fd-accent/60">
              {body}
            </Link>
          ) : (
            <div key={integration.name} className="bg-fd-card p-6">
              {body}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// How it works
// ---------------------------------------------------------------------------

const STEPS: Array<{ icon: LucideIcon; title: string; code: string; text: string }> = [
  {
    icon: Workflow,
    title: 'Pick a source',
    code: 'twitch.chat("mychannel")',
    text: 'Logins, sockets, reconnects and platform rate limits are handled. Every item arrives as clean, typed data.',
  },
  {
    icon: Sparkles,
    title: 'Ask Jev',
    code: 'noul("Is this hateful?")',
    text: 'A plain-language question with named outcomes. Jev answers each item as it arrives, with calibrated probabilities.',
  },
  {
    icon: Braces,
    title: 'Get typed events',
    code: 'chat.on("kind:question")',
    text: 'Event names come from your questions, so a misspelled outcome is a compile error instead of a silent bug.',
  },
  {
    icon: ShieldCheck,
    title: 'Act, safely',
    code: 'twitch.timeout()',
    text: 'A built-in action or any function of yours. Actions stay in dry-run until you arm them, and never touch moderators.',
  },
];

export function HowItWorks() {
  return (
    <Section
      id="how"
      eyebrow="How it works"
      title="Source, question, outcome, action."
      lead="Four steps, one listener. Jev decides what each item means; your code decides what happens next."
    >
      <ol className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((step, index) => (
          <li key={step.title} className="relative rounded-2xl border bg-fd-card p-6">
            <div className="flex items-center gap-3">
              <span className="flex size-8 items-center justify-center rounded-lg border bg-fd-secondary">
                <step.icon className="size-4" />
              </span>
              <span className="font-mono text-xs text-fd-muted-foreground">0{index + 1}</span>
            </div>
            <h3 className="mt-5 font-semibold">{step.title}</h3>
            <p className="mt-3 truncate font-mono text-[12px] text-signal">{step.code}</p>
            <p className="mt-3 text-sm text-fd-muted-foreground">{step.text}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

const CALLOUTS: Array<{ title: string; text: ReactNode }> = [
  {
    title: 'Outcomes are types',
    text: (
      <>
        <InlineCode>&quot;kind:spoiler&quot;</InlineCode> exists because you defined a <InlineCode>spoiler</InlineCode> label. Rename it
        and every handler that listens for it stops compiling.
      </>
    ),
  },
  {
    title: 'Sure, unsure, no',
    text: (
      <>
        <InlineCode>{'{ min: 0.9, review: 0.6 }'}</InlineCode> acts when Jev is confident and emits a{' '}
        <InlineCode>review</InlineCode> event for a person when it isn&apos;t.
      </>
    ),
  },
  {
    title: 'Your code, or ours',
    text: 'Built-in platform actions and your own functions attach the same way. An action for the wrong platform is a type error.',
  },
];

export function CodeShowcase() {
  return (
    <Section
      id="code"
      eyebrow="The API"
      title="One listener. Every outcome typed."
      lead="A working moderator for a Twitch channel. This snippet is type-checked against the library in CI, so it can't drift from the real API."
    >
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start">
        <Code code={snippets.hero} title="moderator.ts" />
        <ul className="grid grid-cols-1 gap-4">
          {CALLOUTS.map((callout) => (
            <li key={callout.title} className="rounded-2xl border bg-fd-card p-5">
              <h3 className="font-semibold">{callout.title}</h3>
              <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">{callout.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

const SAFETY: Array<{ icon: LucideIcon; title: string; text: string }> = [
  { icon: Eye, title: 'Dry-run by default', text: 'Native actions log what they would do until you pass dryRun: false.' },
  {
    icon: UserCheck,
    title: 'Moderators are off-limits',
    text: 'Broadcasters, moderators and VIPs are never timed out, banned or deleted.',
  },
  { icon: Gauge, title: 'Budgets and rate limits', text: 'Cap the day’s spend in tokens and stay under Jev’s rate limits.' },
  { icon: Hourglass, title: 'Fresh or not at all', text: 'Items that waited too long are dropped instead of acted on late.' },
  {
    icon: ShieldCheck,
    title: 'A band for “not sure”',
    text: 'Answers between your review and action thresholds go to a person, not a ban.',
  },
  { icon: ScrollText, title: 'An audit trail', text: 'logTo() writes every answer and action as one JSON line.' },
];

export function Safety() {
  return (
    <Section
      id="safety"
      eyebrow="Safe by default"
      title="Automation you can leave running."
      lead="Moderation mistakes are public. The defaults assume you'd rather miss one message than time out a regular."
    >
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-start">
        <ul className="grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-2">
          {SAFETY.map((item) => (
            <li key={item.title}>
              <item.icon className="size-5 text-signal" />
              <h3 className="mt-3 font-semibold">{item.title}</h3>
              <p className="mt-1.5 text-sm text-fd-muted-foreground">{item.text}</p>
            </li>
          ))}
        </ul>
        <div>
          <Code code={snippets.safety} title="safe-defaults.ts" fullHeight />
          <p className="mt-3 overflow-x-auto rounded-lg border bg-fd-card px-4 py-2.5 font-mono text-xs whitespace-nowrap text-fd-muted-foreground">
            [jev-events] [dry-run] would timeout viewer_42 for 600s (hateful p=0.97)
          </p>
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// The relay behind the demo
// ---------------------------------------------------------------------------

export function RelaySource() {
  const lines = relay.source.trimEnd().split('\n').length;
  return (
    <Section
      id="relay"
      eyebrow="Under the hood"
      title={<>The live feed runs on {lines} lines of Jev Events.</>}
      lead="A small Node service reads a public Twitch chat without logging in, labels up to five messages a second, and hides anything hateful before it reaches your browser. It never moderates anyone, and it leaves the chat a minute after the last visitor does."
    >
      <Code code={relay.source.trimEnd()} title={relay.path} fullHeight />
      <dl className="mt-6 grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Anonymized', 'Usernames become viewer-1234 nicknames on the server. @mentions and links are masked.'],
          ['Hateful text never ships', 'Messages Jev finds likely hateful are sent without their text.'],
          ['Only labeled messages', 'Anything the rate cap skips is never shown, so nothing unscreened reaches the page.'],
          ['A hard daily budget', 'When the day’s tokens are spent, the page switches to a recorded session.'],
        ].map(([title, text]) => (
          <div key={title} className="rounded-2xl border bg-fd-card p-5">
            <dt className="font-semibold">{title}</dt>
            <dd className="mt-1.5 text-fd-muted-foreground">{text}</dd>
          </div>
        ))}
      </dl>
      <a
        href={`${site.github}/tree/main/apps/live-relay`}
        target="_blank"
        rel="noreferrer"
        className="mt-6 inline-flex items-center gap-2 text-sm font-medium hover:underline"
      >
        <GitHubIcon className="size-4" /> Read the relay&apos;s source <ArrowRight className="size-3.5" />
      </a>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

export function Benchmarks() {
  const run = headlineRun;
  return (
    <Section
      id="benchmarks"
      eyebrow="Benchmarks"
      title="Measured, not claimed."
      lead={
        run
          ? `Scored against ${run.items} labeled chat messages with slang, sarcasm, evasions and ${dataset.languages - 1} languages besides English. Borderline cases are left out of these numbers.`
          : `Every number on this site comes from a run of the eval suite in the repository: ${dataset.items} labeled chat messages with slang, sarcasm, evasions and ${dataset.languages - 1} languages besides English.`
      }
    >
      {run ? (
        <BenchmarkNumbers run={run} />
      ) : (
        <div className="flex flex-col gap-6 rounded-2xl border bg-fd-card p-6 md:flex-row md:items-center md:justify-between md:p-8">
          <div className="max-w-xl">
            <h3 className="font-semibold">The first published run is on its way.</h3>
            <p className="mt-2 text-sm text-fd-muted-foreground">
              Until then there are no accuracy numbers here, by design. The dataset, the scoring code and the runner are
              open, so you can measure Jev on your own key in a few minutes.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <InstallCommand command="npm run eval" />
            <ButtonLink href="/docs/benchmarks" variant="secondary">
              <FlaskConical className="size-4" /> Methodology
            </ButtonLink>
          </div>
        </div>
      )}
    </Section>
  );
}

function BenchmarkNumbers({ run }: { run: BenchmarkRun }) {
  const at = (flag: string, threshold: number) => run.flags[flag]?.thresholds.find((score) => score.threshold === threshold);
  const hateful = at('hateful', 0.8);
  const cells = [
    { value: percent(hateful?.precision), label: 'of messages flagged hateful at p ≥ 0.8 really were' },
    { value: percent(hateful?.recall), label: 'of hateful messages caught at p ≥ 0.8' },
    { value: percent(run.kind.lenientAccuracy), label: `right kind (question, hype, backseat…) on ${run.kind.n} messages` },
    {
      value: run.tokens.usdPer1kItems == null ? '–' : `$${run.tokens.usdPer1kItems.toFixed(4)}`,
      label: 'per 1,000 messages, one request each',
    },
  ];
  return (
    <div>
      <dl className="grid grid-cols-2 overflow-hidden rounded-2xl border bg-fd-card md:grid-cols-4">
        {cells.map((cell, index) => (
          <div
            key={cell.label}
            className={cn('flex flex-col gap-1 p-6', index % 2 === 1 && 'border-l', index > 1 && 'border-t md:border-t-0', index === 2 && 'md:border-l')}
          >
            <dt className="order-2 text-xs text-fd-muted-foreground">{cell.label}</dt>
            <dd className="order-1 font-mono text-3xl font-medium tracking-tight tabular-nums">{cell.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-sm text-fd-muted-foreground">
        {run.model} · {new Date(run.date).toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric' })} ·
        median {run.latencyMs.p50 ?? '–'} ms per request.{' '}
        <Link href="/docs/benchmarks" className="font-medium text-fd-foreground hover:underline">
          Full results, per language and per slice →
        </Link>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

interface Recipe {
  usage: string;
  group: string;
  id: string;
  type: string;
  instructions: unknown;
  criteria: unknown;
}

export function Recipes() {
  const chat = (recipes as Recipe[]).filter((recipe) => recipe.group === 'chat');
  const others = (recipes as Recipe[]).filter((recipe) => recipe.group !== 'chat');
  return (
    <Section
      id="recipes"
      eyebrow="Recipes"
      title="Ready-made questions."
      lead="Recipes are plain question objects you can read, copy and change. The chat recipes below are scored in the benchmarks; tune the threshold on your own chat."
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {chat.map((recipe) => (
          <article key={recipe.usage} className="flex flex-col rounded-2xl border bg-fd-card p-5">
            <div className="flex items-center justify-between gap-3">
              <code className="truncate font-mono text-[13px] font-medium">{recipe.usage}</code>
              <span className="shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[10px] text-fd-muted-foreground uppercase">
                {recipe.type}
              </span>
            </div>
            <p className="mt-3 text-sm text-fd-muted-foreground">{String(recipe.instructions)}</p>
            {recipe.type === 'choice' && recipe.criteria !== null && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {Object.keys(recipe.criteria as Record<string, unknown>).map((label) => (
                  <LabelChip key={label} label={label} />
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
      <p className="mt-6 text-sm text-fd-muted-foreground">
        Plus {others.length} recipes for comments, email and calendars.{' '}
        <Link href="/docs/recipes" className="font-medium text-fd-foreground hover:underline">
          See them all →
        </Link>
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Try it, and the end of the page
// ---------------------------------------------------------------------------

const CLI = `export TYPESAFE_API_KEY=...   # your TypeSafe API key

# Label any public Twitch chat. No Twitch login needed.
npx jev-events watch twitch:<channel>

# Ask your own question
npx jev-events watch twitch:<channel> --ask "streamIssue=Is this about the stream's audio or video?"

# Or anything that writes lines
tail -f app.log | npx jev-events watch stdin --ask "Is this an error a human should look at?"`;

const TRY_NOTES: Array<{ icon: Icon; title: string; text: ReactNode }> = [
  {
    icon: TwitchIcon,
    title: 'Any public Twitch chat',
    text: 'Chat is read anonymously, so you only need a TypeSafe key. Nothing is ever posted or moderated.',
  },
  {
    icon: Terminal,
    title: 'Anything with lines',
    text: (
      <>
        <InlineCode>stdin</InlineCode>, <InlineCode>webhook</InlineCode> and the Bluesky firehose work too, with any
        question you ask.
      </>
    ),
  },
  {
    icon: Receipt,
    title: 'A receipt when you stop',
    text: 'Ctrl-C prints how many messages were judged, p50 and p95 latency, tokens and the estimated spend.',
  },
];

export function TryIt() {
  return (
    <Section
      id="try"
      eyebrow="Try it"
      title="Thirty seconds, one command."
      lead="The CLI runs the same engine as the library. Point it at a busy channel and watch Jev label chat in your terminal."
    >
      <Code code={CLI} lang="bash" title="Terminal" fullHeight />
      <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {TRY_NOTES.map((note) => (
          <li key={note.title} className="rounded-2xl border bg-fd-card p-5">
            <note.icon className="size-5 text-signal" />
            <h3 className="mt-3 font-semibold">{note.title}</h3>
            <p className="mt-1.5 text-sm text-fd-muted-foreground">{note.text}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function FinalCta() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 pb-24 sm:px-6">
      <div className="relative overflow-hidden rounded-3xl border bg-fd-card px-6 py-14 text-center md:px-12 md:py-20">
        <div aria-hidden className="bg-grid absolute inset-0 -z-0 opacity-60" />
        <div className="relative">
          <h2 className="text-3xl font-semibold tracking-tight text-balance md:text-5xl">Start listening.</h2>
          <p className="mx-auto mt-4 max-w-lg text-fd-muted-foreground">
            Install the library, bring a TypeSafe key, and ship your first listener before your coffee cools.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <InstallCommand command="npm i jev-events @jev-events/twitch" />
            <ButtonLink href="/docs">
              Read the docs <ArrowRight className="size-4" />
            </ButtonLink>
          </div>
        </div>
      </div>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-12 sm:px-6 md:flex-row md:items-start md:justify-between">
        <div className="max-w-sm">
          <div className="flex items-center gap-2">
            <Logo className="size-6" />
            <span className="font-semibold tracking-tight">{site.name}</span>
          </div>
          <p className="mt-3 text-sm text-fd-muted-foreground">
            Community project built on TypeSafe&apos;s Jev. Not affiliated with TypeSafe.
          </p>
        </div>
        <nav className="grid grid-cols-2 gap-x-12 gap-y-2 text-sm sm:grid-cols-3">
          <Link href="/docs" className="text-fd-muted-foreground hover:text-fd-foreground">
            Docs
          </Link>
          <Link href="/docs/recipes" className="text-fd-muted-foreground hover:text-fd-foreground">
            Recipes
          </Link>
          <Link href="/docs/benchmarks" className="text-fd-muted-foreground hover:text-fd-foreground">
            Benchmarks
          </Link>
          <a href={site.github} className="text-fd-muted-foreground hover:text-fd-foreground">
            GitHub
          </a>
          <a href={site.npm} className="text-fd-muted-foreground hover:text-fd-foreground">
            npm
          </a>
          <a href={site.typesafeDocs} className="text-fd-muted-foreground hover:text-fd-foreground">
            TypeSafe docs
          </a>
        </nav>
      </div>
      <div className="border-t">
        <p className="mx-auto w-full max-w-6xl px-4 py-5 text-xs text-fd-muted-foreground sm:px-6">
          MIT licensed. Twitch, YouTube, Discord, Gmail and Google Calendar are trademarks of their owners.
        </p>
      </div>
    </footer>
  );
}
