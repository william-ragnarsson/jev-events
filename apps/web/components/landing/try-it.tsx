'use client';

// The Try it page: pick a live Twitch channel and a question, and watch Jev answer it for each new
// chat message, on your own TypeSafe key, with the stream playing in Twitch's own player above the
// chat. lib/try/run.ts reads the chat and paces the requests, and /api/try passes each one on to
// TypeSafe.
import { ArrowRight, ArrowUpRight, Check, Copy, Square } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type MouseEvent, type ReactNode } from 'react';

import recipes from '@/generated/recipes.json';
import type { RecipeEntry } from '@/lib/builder/generate';
import { site } from '@/lib/site';
import { channelLogin, type ChatMessage } from '@/lib/try/chat';
import { chatRecipes, EXAMPLE_QUESTION, LIMITS, MAX_QUESTION, tryCode, type TryQuestion } from '@/lib/try/jev';
import { TryRun, type Row, type RowState, type RunView } from '@/lib/try/run';
import { TwitchIcon } from '../brand-icons';
import { CodeLines } from './code-lines';
import { prefersReducedMotion } from './loop';
import { H2, Kicker } from './ui';

const ENTRIES = recipes as RecipeEntry[];
const OPTIONS = chatRecipes(ENTRIES);
const CUSTOM = 'custom';
/** Big channels that are live most days. */
const SUGGESTIONS = ['kaicenat', 'xqc', 'jynxzi'];
/** How long typing in the channel field pauses before the stream changes to what's there. */
const STREAM_DELAY_MS = 600;
/** The name colors Twitch gives chatters who haven't picked one. */
const TWITCH_COLORS = [
  '#FF0000',
  '#0000FF',
  '#008000',
  '#B22222',
  '#FF7F50',
  '#9ACD32',
  '#FF4500',
  '#2E8B57',
  '#DAA520',
  '#D2691E',
  '#5F9EA0',
  '#1E90FF',
  '#FF69B4',
  '#8A2BE2',
  '#00FF7F',
];

const FIELD =
  'h-10 w-full rounded-lg border border-[var(--line-2)] bg-black/30 px-3 text-[14px] outline-none transition-colors placeholder:text-[var(--dim)] focus:border-[var(--accent)]';
const RADIO =
  'mt-[3px] size-4 shrink-0 cursor-pointer appearance-none rounded-full border border-[var(--line-2)] bg-black/30 transition-[border-width,border-color] checked:border-[5px] checked:border-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]';
const HELP = 'mt-1.5 text-[12.5px] leading-relaxed text-pretty text-[var(--dim)]';
const LINK = 'underline decoration-[var(--line-2)] underline-offset-4 transition-colors hover:text-[var(--muted)]';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumSignificantDigits: 2 });
const formatUsd = (value: number) => (value === 0 ? '$0' : usd.format(value));

function clock(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function questionOf(pick: string, custom: string): TryQuestion {
  return pick === CUSTOM ? { custom: custom.trim() } : { recipe: pick };
}

function questionText(pick: string, custom: string): string {
  return pick === CUSTOM ? custom.trim() || EXAMPLE_QUESTION : (OPTIONS.find((o) => o.id === pick)?.text ?? '');
}

/** A chatter's name color as Twitch shows it, made light enough to read on the dark page. */
function nameColor({ color, login }: ChatMessage): string {
  let hash = 0;
  for (const char of login) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `oklch(from ${color ?? TWITCH_COLORS[hash % TWITCH_COLORS.length]!} max(l, 0.72) c h)`;
}

export function TryIt() {
  const [apiKey, setApiKey] = useState('');
  const [channel, setChannel] = useState('');
  // The channel in the player, which waits for typing to pause.
  const [streamLogin, setStreamLogin] = useState<string>();
  const [pick, setPick] = useState(OPTIONS[0]?.id ?? CUSTOM);
  const [custom, setCustom] = useState('');
  const [problem, setProblem] = useState<string>();
  const [view, setView] = useState<RunView>();
  // What the current run asks, which stays put if the form changes after it stops.
  const [asked, setAsked] = useState<{ id: string; text: string }>();
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const [tab, setTab] = useState<'chat' | 'code'>('code');
  const [now, setNow] = useState(0);
  const run = useRef<TryRun>(undefined);
  const stage = useRef<HTMLDivElement>(null);

  const running = view !== undefined && view.phase !== 'stopped';
  const login = channelLogin(channel);
  const left = view?.endsAt ? Math.max(0, view.endsAt - now) : undefined;

  useEffect(() => () => run.current?.stop(), []);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    const timer = setTimeout(() => setStreamLogin(login), STREAM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [login]);

  const changeChannel = (value: string) => {
    setChannel(value);
    // A new channel starts over, so the chat under its stream never shows another channel's messages.
    if (view?.phase === 'stopped' && channelLogin(value) !== view.channel) {
      run.current = undefined;
      setView(undefined);
      setAsked(undefined);
    }
  };

  const start = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const key = apiKey.trim();
    if (!login) {
      return setProblem(
        channel.trim() ? "That isn't a Twitch channel. Enter a name like xqc, or a link like twitch.tv/xqc." : 'Pick a Twitch channel.',
      );
    }
    if (pick === CUSTOM && !custom.trim()) return setProblem('Write your question, or pick one of the others.');
    if (!key) return setProblem('Paste your TypeSafe API key.');

    setProblem(undefined);
    // A run left going would keep spending the key where nobody can see it.
    run.current?.stop();
    const next = new TryRun({
      channel: login,
      key,
      question: questionOf(pick, custom),
      onChange: (v) => {
        if (run.current !== next) return;
        setView(v);
        setNow(Date.now());
      },
    });
    run.current = next;
    next.start();
    setView(next.view);
    setNow(Date.now());
    setStreamLogin(login);
    setAsked({ id: pick, text: questionText(pick, custom) });
    setRevealed(new Set());
    setTab('chat');
    // On phones the stream and the chat are below the form. On wide screens they stay in view, except
    // at the very bottom of the page, where the footer pushes them up.
    const phone = window.matchMedia('(max-width: 1023px)').matches;
    stage.current?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: phone ? 'start' : 'nearest' });
  };

  const stop = (e: MouseEvent<HTMLButtonElement>) => {
    // This button turns into the Start button before the click is over, and the browser would take
    // the click as submitting the form and start a new run.
    e.preventDefault();
    run.current?.stop('Stopped.');
    if (run.current) setView(run.current.view);
  };

  let status: { text: string; warn?: boolean } | undefined;
  if (problem) status = { text: problem, warn: true };
  else if (view?.phase === 'joining') status = { text: `Joining #${view.channel}…` };
  else if (view?.phase === 'reading') {
    status = view.quiet
      ? { text: `Nobody has written in #${view.channel} for a while. Check that it's live, or try a busier channel.` }
      : { text: `Reading #${view.channel}. It stops by itself after five minutes.` };
  } else if (view?.phase === 'waiting') status = { text: view.note ?? 'Waiting.', warn: true };
  else if (view?.phase === 'stopped') status = { text: view.note ?? 'Stopped.', warn: view.failed };

  const phase = !view
    ? ''
    : view.phase === 'joining'
      ? 'joining…'
      : view.phase === 'waiting'
        ? 'paused'
        : view.phase === 'stopped'
          ? 'stopped'
          : left !== undefined
            ? `${clock(left)} left`
            : 'live';

  return (
    <section className="mx-auto grid max-w-7xl gap-10 px-6 pt-10 pb-24 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:pt-14">
      <div>
        <Kicker>Try it in your browser</Kicker>
        <h1 className={`mt-4 ${H2}`}>Point Jev at a live Twitch chat.</h1>
        <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-pretty text-[var(--muted)]">
          Pick a live channel and a question, paste your TypeSafe key, and press Start. The stream plays in Twitch&apos;s own player, its
          chat comes straight from Twitch, and Jev&apos;s answer shows up next to each new message. Nothing to install.
        </p>

        <form onSubmit={start} noValidate className="mt-10">
          <fieldset disabled={running} className="space-y-7 transition-opacity disabled:opacity-60">
            <div>
              <label htmlFor="try-channel" className="text-[13px] font-medium">
                <Step n={1} />
                Pick a live Twitch channel
              </label>
              <input
                id="try-channel"
                type="text"
                value={channel}
                onChange={(e) => changeChannel(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="xqc or twitch.tv/xqc"
                className={`mt-2 ${FIELD}`}
              />
              <p className={HELP}>
                The channel&apos;s name or a link to the stream: both work. Try{' '}
                {SUGGESTIONS.map((name, i) => (
                  <span key={name}>
                    <button
                      type="button"
                      onClick={() => {
                        changeChannel(name);
                        setStreamLogin(name);
                      }}
                      className={`font-mono text-[var(--muted)] ${LINK}`}
                    >
                      {name}
                    </button>
                    {i < SUGGESTIONS.length - 2 ? ', ' : i === SUGGESTIONS.length - 2 ? ' or ' : ''}
                  </span>
                ))}
                .
              </p>
            </div>

            <fieldset>
              <legend className="text-[13px] font-medium">
                <Step n={2} />
                Pick a question for each message
              </legend>
              <div className="mt-2 divide-y divide-[var(--line)] overflow-hidden rounded-lg border border-[var(--line-2)]">
                {OPTIONS.map((o) => (
                  <label
                    key={o.id}
                    className="flex cursor-pointer gap-3 px-3.5 py-2.5 transition-colors hover:bg-white/[0.02] has-checked:bg-white/[0.035]"
                  >
                    <input type="radio" name="try-question" checked={pick === o.id} onChange={() => setPick(o.id)} className={RADIO} />
                    <span className="min-w-0">
                      <span className="block text-[13.5px] leading-snug">{o.text}</span>
                      <span className="mt-1 block font-mono text-[11px] leading-snug text-[var(--dim)]">
                        recipes.chat.{o.id} · {o.type === 'choice' ? `picks one of ${o.labels.join(', ')}` : 'yes or no'}
                      </span>
                    </span>
                  </label>
                ))}
                <div className="flex gap-3 px-3.5 py-2.5 transition-colors has-checked:bg-white/[0.035]">
                  <input
                    id="try-custom"
                    type="radio"
                    name="try-question"
                    checked={pick === CUSTOM}
                    onChange={() => setPick(CUSTOM)}
                    className={RADIO}
                  />
                  <div className="min-w-0 flex-1">
                    <label htmlFor="try-custom" className="block cursor-pointer text-[13.5px] leading-snug">
                      Your own yes-or-no question
                    </label>
                    <input
                      type="text"
                      value={custom}
                      onChange={(e) => {
                        setCustom(e.target.value);
                        setPick(CUSTOM);
                      }}
                      onFocus={() => setPick(CUSTOM)}
                      maxLength={MAX_QUESTION}
                      aria-label="Your own question"
                      placeholder={EXAMPLE_QUESTION}
                      className={`mt-2 ${FIELD}`}
                    />
                  </div>
                </div>
              </div>
            </fieldset>

            <div>
              <label htmlFor="try-key" className="text-[13px] font-medium">
                <Step n={3} />
                Paste your TypeSafe API key
              </label>
              <input
                id="try-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                placeholder="Your key"
                className={`mt-2 font-mono ${FIELD}`}
              />
              <p className={HELP}>
                It goes to this site&apos;s server only to be passed on to TypeSafe with each message, and it isn&apos;t saved or logged.{' '}
                <a href={site.typesafe} className={LINK}>
                  Get a key from TypeSafe
                </a>
                .
              </p>
            </div>
          </fieldset>

          <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
            {running ? (
              <button
                type="button"
                onClick={stop}
                className="inline-flex h-11 items-center gap-2.5 rounded-md border border-[var(--line-2)] bg-white/[0.04] px-5 text-[14.5px] font-medium transition-colors hover:bg-white/[0.08]"
              >
                <Square aria-hidden className="size-3 fill-current" /> Stop
              </button>
            ) : (
              <button
                type="submit"
                className="group inline-flex h-11 items-center gap-2.5 rounded-md bg-[var(--accent)] pr-4 pl-5 text-[14.5px] font-medium text-[var(--accent-ink)] transition-[filter] hover:brightness-110"
              >
                {view ? 'Start again' : 'Start'}
                <ArrowRight aria-hidden className="size-4 transition-transform duration-300 group-hover:translate-x-0.5" />
              </button>
            )}
            <p aria-live="polite" className={`min-w-0 flex-1 basis-56 text-[13px] leading-snug ${status?.warn ? 'text-[var(--review)]' : 'text-[var(--muted)]'}`}>
              {status?.text}
            </p>
          </div>

          <p className="mt-8 text-[12px] leading-relaxed text-pretty text-[var(--dim)]">
            The number next to an answer is Jev&apos;s probability: that the answer is yes, or that it picked the right label. So a busy chat
            can&apos;t run up your bill, this asks about {LIMITS.perSecond} messages a second at most and skips the rest.
          </p>
        </form>
      </div>

      {/* On wide screens this stays in view while the form scrolls, so the stream and chat are there when Start is pressed. */}
      <div ref={stage} className="scroll-mt-20 lg:sticky lg:top-20 lg:self-start">
        <div className="landing-console flex flex-col overflow-hidden rounded-2xl lg:h-[calc(100svh-7rem)] lg:max-h-[60rem] lg:min-h-[34rem]">
          <Stream login={streamLogin} />
          <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-[var(--line)] pr-2 pl-4 text-[13px]">
            <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${running ? 'landing-live-dot bg-[var(--accent)]' : 'bg-[var(--line-2)]'}`} />
            {streamLogin ? (
              <a
                href={`https://www.twitch.tv/${streamLogin}`}
                target="_blank"
                rel="noreferrer"
                title={`Open #${streamLogin} on twitch.tv`}
                className="group flex min-w-0 items-center gap-1 font-medium"
              >
                <span className="truncate">#{streamLogin}</span>
                <ArrowUpRight aria-hidden className="size-3.5 shrink-0 text-[var(--dim)] transition-colors group-hover:text-[var(--fg)]" />
              </a>
            ) : (
              <span className="truncate font-medium">Twitch chat</span>
            )}
            <span className="font-mono text-[11px] whitespace-nowrap text-[var(--dim)] tabular-nums">{phase}</span>
            <div className="ml-auto flex shrink-0 gap-1">
              <Tab on={tab === 'chat'} onClick={() => setTab('chat')}>
                Chat
              </Tab>
              <Tab on={tab === 'code'} onClick={() => setTab('code')}>
                Code
              </Tab>
            </div>
          </div>
          {/* The feed scrolls inside a box of its own, so a busy chat can't make the page longer. */}
          <div className="relative min-h-[22rem] flex-1 lg:min-h-0">
            <div className="absolute inset-0 flex flex-col">
              {tab === 'chat' ? (
                <Chat
                  view={view}
                  question={asked?.text ?? questionText(pick, custom)}
                  redact={asked?.id === 'hateful'}
                  revealed={revealed}
                  onReveal={(id) => setRevealed((ids) => new Set(ids).add(id))}
                />
              ) : (
                <CodeView code={tryCode(login, questionOf(pick, custom), ENTRIES)} />
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Step({ n }: { n: number }) {
  return (
    <span aria-hidden className="mr-2.5 font-mono text-[11.5px] text-[var(--accent)]">
      {n}
    </span>
  );
}

const noSubscribe = () => () => {};

/** The channel's stream in Twitch's own player, muted, so it's plain the chat under it is the real one. */
function Stream({ login }: { login: string | undefined }) {
  // Twitch's player only plays on sites it's told the name of, and only the browser knows it.
  const host = useSyncExternalStore(
    noSubscribe,
    () => window.location.hostname,
    () => undefined,
  );
  return (
    <div className="relative aspect-video shrink-0 border-b border-[var(--line)] bg-black lg:min-h-[300px]">
      {login && host ? (
        <iframe
          // A new player for each channel, where changing the address would add to the back button's history.
          key={login}
          src={`https://player.twitch.tv/?${new URLSearchParams({ channel: login, parent: host, muted: 'true', autoplay: 'true' })}`}
          title={`#${login} on Twitch`}
          allow="autoplay"
          allowFullScreen
          className="absolute inset-0 size-full"
        />
      ) : (
        <p className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-[13px] text-[var(--dim)]">
          <TwitchIcon aria-hidden className="size-6" />
          Pick a channel, and its stream plays here.
        </p>
      )}
    </div>
  );
}

function Tab({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-[12.5px] transition-colors ${on ? 'bg-white/[0.07] text-[var(--fg)]' : 'text-[var(--muted)] hover:text-[var(--fg)]'}`}
    >
      {children}
    </button>
  );
}

function Chat({
  view,
  question,
  redact,
  revealed,
  onReveal,
}: {
  view: RunView | undefined;
  question: string;
  redact: boolean;
  revealed: ReadonlySet<string>;
  onReveal: (id: string) => void;
}) {
  let empty: string;
  if (!view) empty = "Chat messages and Jev's answers show up here once you start.";
  else if (view.phase === 'joining') empty = `Joining #${view.channel}…`;
  else if (view.phase === 'stopped') empty = view.note ?? 'Stopped.';
  else if (view.quiet) empty = `Nobody has written in #${view.channel} for 20 seconds. Check that it's live, or try a busier channel.`;
  else empty = `Joined #${view.channel}. Waiting for the next message…`;

  return (
    <>
      <p className="line-clamp-2 shrink-0 border-b border-[var(--line)] px-4 py-2.5 text-[12.5px] leading-snug text-[var(--muted)]">
        <span className="mr-2 font-mono text-[10.5px] tracking-[0.14em] text-[var(--dim)] uppercase">Asks</span>
        {question}
      </p>
      {view && view.rows.length > 0 ? (
        <ol aria-label="Chat messages with Jev's answers" className="min-h-0 flex-1 overflow-y-auto">
          {view.rows.map((row) => (
            <FeedRow
              key={row.message.id}
              row={row}
              redact={redact}
              revealed={revealed.has(row.message.id)}
              onReveal={() => onReveal(row.message.id)}
            />
          ))}
        </ol>
      ) : (
        <p className="min-h-0 flex-1 px-4 py-5 text-[13px] leading-relaxed text-[var(--muted)]">{empty}</p>
      )}
      <div className="flex h-10 shrink-0 items-center gap-4 overflow-hidden border-t border-[var(--line)] px-4 font-mono text-[11px] whitespace-nowrap text-[var(--dim)]">
        <Stat n={view?.read ?? 0}>read</Stat>
        <Stat n={view?.answered ?? 0}>answered</Stat>
        {/* Phones leave out the skipped count and the timing, so the dollar amount still fits. */}
        <Stat n={view?.skipped ?? 0} className="hidden sm:inline">
          skipped
        </Stat>
        {view?.latencyMs !== undefined && (
          <span className="hidden sm:inline">
            <span className="text-[var(--fg)] tabular-nums">{Math.round(view.latencyMs)}</span> ms each
          </span>
        )}
        <span className="ml-auto">
          <span className="text-[var(--fg)] tabular-nums">{formatUsd(view?.spentUsd ?? 0)}</span> spent
        </span>
      </div>
    </>
  );
}

function Stat({ n, className, children }: { n: number; className?: string; children: ReactNode }) {
  return (
    <span className={className}>
      <span className="text-[var(--fg)] tabular-nums">{n.toLocaleString('en-US')}</span> {children}
    </span>
  );
}

function FeedRow({ row, redact, revealed, onReveal }: { row: Row; redact: boolean; revealed: boolean; onReveal: () => void }) {
  const { message, state } = row;
  const yes = state.status === 'answered' && state.answer.type === 'noul' && state.answer.p >= 0.5;
  const hidden = redact && yes && !revealed;
  return (
    <li className={`landing-rise flex items-baseline gap-4 border-b border-[var(--line)] px-4 py-2 ${yes ? 'landing-line-on' : ''}`}>
      <p className="min-w-0 flex-1 text-[13px] leading-snug break-words">
        <span className="mr-2 font-medium text-[var(--muted)]" style={{ color: nameColor(message) }}>
          {message.author}
        </span>
        {hidden ? (
          <>
            <span role="img" aria-label="Hidden because Jev thinks it's hateful" className="landing-redacted" />
            <button type="button" onClick={onReveal} className={`ml-2 font-mono text-[11px] text-[var(--dim)] ${LINK}`}>
              show
            </button>
          </>
        ) : (
          message.text
        )}
      </p>
      <Answer state={state} />
    </li>
  );
}

const ANSWER = 'shrink-0 text-right font-mono text-[11.5px] whitespace-nowrap tabular-nums';

function Answer({ state }: { state: RowState }) {
  if (state.status === 'asking') return <span className={`${ANSWER} animate-pulse text-[var(--dim)]`}>asking…</span>;
  if (state.status === 'stopped') return <span className={`${ANSWER} text-[var(--dim)]`}>stopped</span>;
  if (state.status === 'failed') {
    return (
      <span title={state.error} className={`${ANSWER} text-[var(--review)]`}>
        error
      </span>
    );
  }
  const { answer, latencyMs } = state;
  const title = `Answered in ${Math.round(latencyMs)} ms`;
  if (answer.type === 'choice') {
    return (
      <span title={title} className={ANSWER}>
        {answer.label} <span className="text-[var(--dim)]">{answer.p.toFixed(2)}</span>
      </span>
    );
  }
  const yes = answer.p >= 0.5;
  return (
    <span title={title} className={`${ANSWER} ${yes ? 'text-[var(--accent)]' : 'text-[var(--dim)]'}`}>
      {yes ? 'yes' : 'no'} {answer.p.toFixed(2)}
    </span>
  );
}

function CodeView({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto">
        <CodeLines code={code} wrap className="py-4 pr-4 font-mono text-[11.5px] leading-[1.7]" />
      </div>
      <div className="flex h-10 shrink-0 items-center gap-4 border-t border-[var(--line)] px-4 text-[12.5px] text-[var(--muted)]">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(
              () => setCopied(true),
              () => {},
            );
          }}
          className="inline-flex items-center gap-1.5 transition-colors hover:text-[var(--fg)]"
        >
          {copied ? <Check aria-hidden className="size-3.5 text-[var(--accent)]" /> : <Copy aria-hidden className="size-3.5" />}
          {copied ? 'Copied' : 'Copy the code'}
        </button>
        <Link href="/docs/quickstart" className="group ml-auto inline-flex items-center gap-1.5 transition-colors hover:text-[var(--fg)]">
          How to run it <ArrowRight aria-hidden className="size-3.5 transition-transform duration-300 group-hover:translate-x-0.5" />
        </Link>
      </div>
    </>
  );
}
