'use client';

// The Try it page: pick a live Twitch channel and a question, and watch Jev answer it for each new
// chat message, on your own TypeSafe key, with the stream playing in Twitch's own player above a chat
// that looks like Twitch's. lib/try/run.ts reads the chat and paces the requests, and /api/try passes
// each one on to TypeSafe.
import Link from 'next/link';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';

import { TwitchIcon } from '@/components/brand-icons';
import { Logo } from '@/components/logo';
import recipes from '@/generated/recipes.json';
import type { RecipeEntry } from '@/lib/builder/generate';
import { site } from '@/lib/site';
import { channelLogin, type ChatMessage } from '@/lib/try/chat';
import { chatRecipes, EXAMPLE_QUESTION, LIMITS, MAX_QUESTION, TRY_QUESTIONS, tryCode, type TryQuestion } from '@/lib/try/jev';
import { TryRun, type Row, type RowState, type RunView } from '@/lib/try/run';
import './try.css';

const ENTRIES = recipes as RecipeEntry[];
const RECIPES = chatRecipes(ENTRIES);
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
const TABS = ['chat', 'code'] as const;
type Tab = (typeof TABS)[number];
type Field = 'channel' | 'custom' | 'key';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumSignificantDigits: 2 });
const formatUsd = (value: number) => (value === 0 ? '$0' : usd.format(value));

function questionOf(pick: string, custom: string): TryQuestion {
  return pick === CUSTOM ? { custom: custom.trim() } : { recipe: pick };
}

function questionText(pick: string, custom: string): string {
  return pick === CUSTOM ? custom.trim() || EXAMPLE_QUESTION : (RECIPES.find((recipe) => recipe.id === pick)?.text ?? '');
}

/** A chatter's name color as Twitch shows it, made light enough to read on the dark chat. */
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
  const [pick, setPick] = useState<string>(TRY_QUESTIONS[0].id);
  const [custom, setCustom] = useState('');
  const [problem, setProblem] = useState<{ text: string; field: Field }>();
  const [view, setView] = useState<RunView>();
  // What the current run asks, which stays put if the form changes after it stops.
  const [asked, setAsked] = useState<{ id: string; text: string }>();
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const [tab, setTab] = useState<Tab>('chat');
  // Counts the runs, so each one gets a fresh chat that follows its newest message.
  const [runs, setRuns] = useState(0);
  const run = useRef<TryRun>(undefined);
  const stage = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const fields = {
    channel: useRef<HTMLInputElement>(null),
    custom: useRef<HTMLInputElement>(null),
    key: useRef<HTMLInputElement>(null),
  };

  const running = view !== undefined && view.phase !== 'stopped';
  const login = channelLogin(channel);

  useEffect(() => () => run.current?.stop(), []);
  useEffect(() => {
    const timer = setTimeout(() => setStreamLogin(login), STREAM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [login]);
  // On phones the stream and the chat are below the form, so a new run scrolls to them. On wide
  // screens they're beside it, and it scrolls only as far as the whole chat needs.
  useEffect(() => {
    if (runs === 0) return;
    const phone = window.matchMedia('(max-width: 1023px)').matches;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    (phone ? stage : screen).current?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: phone ? 'start' : 'nearest' });
  }, [runs]);

  /** Keeps a problem up until the field it's about changes. */
  const edited = (field: Field) => {
    if (problem?.field === field) setProblem(undefined);
  };

  const changeChannel = (value: string) => {
    setChannel(value);
    edited('channel');
    // A new channel starts over, so the chat under its stream never shows another channel's messages.
    if (view?.phase === 'stopped' && channelLogin(value) !== view.channel) {
      run.current = undefined;
      setView(undefined);
      setAsked(undefined);
    }
  };

  const fail = (text: string, field: Field) => {
    setProblem({ text, field });
    fields[field].current?.focus();
  };

  const start = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const key = apiKey.trim();
    if (!login) {
      return fail(
        channel.trim() ? "That isn't a Twitch channel. Enter a name like xqc, or a link like twitch.tv/xqc." : 'Pick a Twitch channel.',
        'channel',
      );
    }
    if (pick === CUSTOM && !custom.trim()) return fail('Write your question, or pick one of the others.', 'custom');
    if (!key) return fail('Paste your TypeSafe key.', 'key');

    setProblem(undefined);
    // A run left going would keep spending the key where nobody can see it.
    run.current?.stop();
    const next = new TryRun({
      channel: login,
      key,
      question: questionOf(pick, custom),
      onChange: (v) => {
        if (run.current === next) setView(v);
      },
    });
    run.current = next;
    next.start();
    setView(next.view);
    setStreamLogin(login);
    setAsked({ id: pick, text: questionText(pick, custom) });
    setRevealed(new Set());
    setRuns((n) => n + 1);
    setTab('chat');
  };

  const stop = (e: MouseEvent<HTMLButtonElement>) => {
    // This button turns into the Start button before the click is over, and the browser would take
    // the click as submitting the form and start a new run.
    e.preventDefault();
    run.current?.stop('Stopped.');
    if (run.current) setView(run.current.view);
  };

  let status: { text: string; warn?: boolean } | undefined;
  if (problem) status = { text: problem.text, warn: true };
  else if (view?.phase === 'joining') status = { text: `Joining #${view.channel}…` };
  else if (view?.phase === 'reading') {
    status = view.quiet
      ? { text: `Nobody has written in #${view.channel} for a while. Check that it's live, or try a busier channel.` }
      : { text: `Reading #${view.channel}. It stops by itself after five minutes.` };
  } else if (view?.phase === 'waiting') status = { text: view.note ?? 'Waiting.', warn: true };
  else if (view?.phase === 'stopped') status = { text: view.note ?? 'Stopped.', warn: view.failed };

  // The props that tie a field to the problem with it, if there is one.
  const invalid = (field: Field) =>
    problem?.field === field ? { 'aria-invalid': true, 'aria-describedby': 'try-status' } : { 'aria-invalid': false };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + 1) % TABS.length]!;
    setTab(next);
    document.getElementById(`try-tab-${next}`)?.focus();
  };

  return (
    <div className="try-it">
      <div className="try-side">
        <div className="try-intro">
          <h1 className="try-title">
            Point Jev at a live
            <br />
            Twitch chat.
          </h1>
          <p className="try-lead">Pick a channel and a question. Nothing to install.</p>
        </div>

        <form className="try-form" onSubmit={start} noValidate>
          <fieldset className="try-fields" disabled={running}>
            <div className="try-field">
              <label htmlFor="try-channel" className="try-label">
                Channel
              </label>
              <input
                ref={fields.channel}
                id="try-channel"
                type="text"
                value={channel}
                onChange={(e) => changeChannel(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="xqc or twitch.tv/xqc"
                className="try-input"
                {...invalid('channel')}
              />
              <p className="try-help">
                Or try{' '}
                {SUGGESTIONS.map((name, i) => (
                  <span key={name}>
                    <button
                      type="button"
                      className="try-suggestion"
                      onClick={() => {
                        changeChannel(name);
                        setStreamLogin(name);
                      }}
                    >
                      {name}
                    </button>
                    {i < SUGGESTIONS.length - 2 ? ', ' : i === SUGGESTIONS.length - 2 ? ' or ' : '.'}
                  </span>
                ))}
              </p>
            </div>

            <fieldset className="try-question">
              <legend>Question</legend>
              <div>
                {TRY_QUESTIONS.map((question) => (
                  <label key={question.id} className="try-option">
                    <input
                      type="radio"
                      name="try-question"
                      checked={pick === question.id}
                      onChange={() => {
                        setPick(question.id);
                        edited('custom');
                      }}
                    />
                    {question.label}
                  </label>
                ))}
                <label className="try-option">
                  <input type="radio" name="try-question" checked={pick === CUSTOM} onChange={() => setPick(CUSTOM)} />
                  Your own question
                </label>
                {pick === CUSTOM && (
                  <input
                    ref={fields.custom}
                    type="text"
                    value={custom}
                    onChange={(e) => {
                      setCustom(e.target.value);
                      edited('custom');
                    }}
                    maxLength={MAX_QUESTION}
                    aria-label="Your own yes-or-no question"
                    placeholder={EXAMPLE_QUESTION}
                    className="try-input try-custom"
                    {...invalid('custom')}
                  />
                )}
              </div>
            </fieldset>

            <div className="try-field">
              <label htmlFor="try-key" className="try-label">
                TypeSafe key
              </label>
              <input
                ref={fields.key}
                id="try-key"
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  edited('key');
                }}
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                placeholder="Your key"
                className="try-input"
                {...invalid('key')}
              />
              <p className="try-help">
                Only passed on to TypeSafe. Never saved.{' '}
                <a href={site.typesafe} target="_blank" rel="noreferrer">
                  Get a key from TypeSafe <span aria-hidden="true">→</span>
                </a>
              </p>
            </div>
          </fieldset>

          <div className="try-actions">
            {running ? (
              <button type="button" onClick={stop} className="try-start">
                Stop
              </button>
            ) : (
              <button type="submit" className="try-start">
                {view ? 'Start again' : 'Start'}
              </button>
            )}
            <p id="try-status" aria-live="polite" className={status?.warn ? 'try-status is-warn' : 'try-status'}>
              {status?.text}
            </p>
          </div>
        </form>
      </div>

      <div ref={stage} className="try-stage">
        <Stream login={streamLogin} />
        <div ref={screen} className="try-screen">
          <div className="try-bar">
            <div role="tablist" aria-label="Under the stream" className="try-tablist">
              {TABS.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  id={`try-tab-${name}`}
                  aria-selected={tab === name}
                  aria-controls={tab === name ? 'try-panel' : undefined}
                  tabIndex={tab === name ? 0 : -1}
                  onClick={() => setTab(name)}
                  onKeyDown={onTabKey}
                  className="try-tab"
                  data-text={name === 'chat' ? 'Chat' : 'Code'}
                >
                  {name === 'chat' ? 'Chat' : 'Code'}
                </button>
              ))}
            </div>
            <Stats view={view} />
          </div>
          <div role="tabpanel" id="try-panel" aria-labelledby={`try-tab-${tab}`}>
            {tab === 'chat' ? (
              <>
                <Chat
                  key={runs}
                  view={view}
                  question={asked?.text ?? questionText(pick, custom)}
                  redact={asked?.id === 'hateful'}
                  revealed={revealed}
                  onReveal={(id) => setRevealed((ids) => new Set(ids).add(id))}
                />
                <p className="try-note">
                  The number is Jev&apos;s probability of yes. At most {LIMITS.perSecond} messages a second are asked.
                </p>
              </>
            ) : (
              <CodeView code={tryCode(login, questionOf(pick, custom), ENTRIES)} />
            )}
          </div>
        </div>
      </div>
    </div>
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
    <div className="try-player">
      {login && host ? (
        <iframe
          // A new player for each channel, where changing the address would add to the back button's history.
          key={login}
          src={`https://player.twitch.tv/?${new URLSearchParams({ channel: login, parent: host, muted: 'true', autoplay: 'true' })}`}
          title={`#${login} on Twitch`}
          allow="autoplay; fullscreen"
          allowFullScreen
        />
      ) : (
        <p>
          <TwitchIcon aria-hidden="true" />
          Pick a channel, and its stream plays here.
        </p>
      )}
    </div>
  );
}

/** What the run has done so far. Phones leave out the skipped count and the timing. */
function Stats({ view }: { view: RunView | undefined }) {
  const count = (n: number) => n.toLocaleString('en-US');
  return (
    <p className="try-stats">
      <span>{count(view?.read ?? 0)} read&nbsp;·</span> <span>{count(view?.answered ?? 0)} answered&nbsp;·</span>{' '}
      <span className="try-wide">{count(view?.skipped ?? 0)} skipped&nbsp;·</span>{' '}
      {view?.latencyMs !== undefined && (
        <>
          <span className="try-wide">{Math.round(view.latencyMs)} ms each&nbsp;·</span>{' '}
        </>
      )}
      <span>{formatUsd(view?.spentUsd ?? 0)} spent</span>
    </p>
  );
}

/** How near the bottom of the chat still counts as at the bottom, in pixels. */
const BOTTOM_PX = 24;

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
  const list = useRef<HTMLOListElement>(null);
  // Where the chat was scrolled to and the size of its box when last looked at.
  const seen = useRef({ top: 0, width: 0, height: 0 });
  // Like Twitch's, the chat pauses while you scroll up to read: the messages on screen hold still,
  // with their answers still coming in, until you scroll back down to the newest.
  const [held, setHeld] = useState<readonly Row[]>();
  const live = view !== undefined && view.phase !== 'stopped';
  const rows = view?.rows ?? [];
  const latest = new Map(rows.map((row) => [row.message.id, row]));
  const fresh = (row: Row) => latest.get(row.message.id) ?? row;
  // The run keeps only its newest rows, so the held ones can include rows it has let go of. Once
  // it stops, what came in while paused goes below them, so nothing above where you're reading moves.
  const shown = !held ? rows : live ? held.map(fresh) : [...held.filter((row) => !latest.has(row.message.id)), ...rows];

  // Keeps the answers on the held rows, for when the run lets go of them.
  useEffect(() => setHeld((held) => held?.map(fresh)), [view?.rows]);

  const look = (el: HTMLOListElement) => {
    const was = seen.current;
    seen.current = { top: el.scrollTop, width: el.clientWidth, height: el.clientHeight };
    return was;
  };

  // Keeps the newest message in view at the bottom, unless you've scrolled up.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (!held) el.scrollTop = el.scrollHeight;
    look(el);
  }, [rows, held]);

  const onScroll = () => {
    const el = list.current;
    if (!el) return;
    const was = look(el);
    const below = el.scrollHeight - el.scrollTop - el.clientHeight;
    // A scroll that comes with a new size of box is the browser keeping its place through a resize,
    // the window's or a phone turning, so the chat keeps following. (Its content changes height all
    // the time, as rows rise in, so that isn't compared.)
    if (el.clientWidth !== was.width || el.clientHeight !== was.height) {
      if (!held) el.scrollTop = el.scrollHeight;
    }
    // Any other scroll up pauses it (the pixel is slack for zoomed pages), and only scrolling back
    // down to the newest picks it up again. Once it has stopped, the rows stay as they are.
    else if (el.scrollTop < was.top && below > 1 && !held) setHeld(shown);
    else if (el.scrollTop > was.top && below <= BOTTOM_PX && held && live) setHeld(undefined);
  };

  let empty: string;
  if (!view) empty = "Chat messages and Jev's answers show up here once you start.";
  else if (view.phase === 'joining') empty = `Joining #${view.channel}…`;
  else if (view.phase === 'stopped') empty = view.note ?? 'Stopped.';
  else if (view.quiet) empty = `Nobody has written in #${view.channel} for 20 seconds. Check that it's live, or try a busier channel.`;
  else empty = `Joined #${view.channel}. Waiting for the next message…`;

  return (
    <div className="try-chat">
      <div className="try-chat-head">Stream chat</div>
      <div className="try-pinned">
        <Logo tone="chat" />
        <p>
          <span>Jev asks:</span> <b>{question}</b>
        </p>
      </div>
      {/* The chat scrolls inside a box of its own, so a busy chat can't make the page longer. */}
      <div className="try-chat-body">
        {shown.length > 0 ? (
          // Oldest first, filling up from the bottom like a chat. It keeps its own place, above, so
          // the browser's scroll anchoring is off.
          <ol
            ref={list}
            onScroll={onScroll}
            onWheel={(e) => {
              // Pauses on the first turn of the wheel, before a new message can pull the chat back down.
              if (e.deltaY < 0 && e.currentTarget.scrollTop > 0 && !held) setHeld(shown);
            }}
            aria-label="Chat messages with Jev's answers"
            className="try-chat-list"
          >
            {shown.map((row) => (
              <ChatRow
                key={row.message.id}
                row={row}
                redact={redact}
                revealed={revealed.has(row.message.id)}
                onReveal={() => onReveal(row.message.id)}
              />
            ))}
          </ol>
        ) : (
          <p className="try-chat-empty">{empty}</p>
        )}
        {held && live && (
          <button type="button" onClick={() => setHeld(undefined)} className="try-paused">
            {/* Phones leave out why, so it fits on one line. */}
            <span className="try-wide">Chat paused while you scroll up. </span>
            Back to the newest <span aria-hidden="true">↓</span>
          </button>
        )}
      </div>
    </div>
  );
}

function ChatRow({ row, redact, revealed, onReveal }: { row: Row; redact: boolean; revealed: boolean; onReveal: () => void }) {
  const { message, state } = row;
  const yes = state.status === 'answered' && state.answer.type === 'noul' && state.answer.p >= 0.5;
  const hidden = redact && yes && !revealed;
  return (
    <li className={yes ? 'try-row is-yes' : 'try-row'}>
      <p>
        <b style={{ color: nameColor(message) }}>{message.author}</b>:{' '}
        {hidden ? (
          <>
            <i className="try-hidden">Hidden because Jev thinks it&apos;s hateful.</i>{' '}
            <button type="button" onClick={onReveal} className="try-show">
              Show
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

function Answer({ state }: { state: RowState }) {
  if (state.status === 'asking') return <span className="try-answer try-asking">asking…</span>;
  if (state.status === 'stopped') return <span className="try-answer">stopped</span>;
  if (state.status === 'failed') {
    return (
      <span title={state.error} className="try-answer try-failed">
        error
      </span>
    );
  }
  const { answer, latencyMs } = state;
  const title = `Answered in ${Math.round(latencyMs)} ms`;
  if (answer.type === 'choice') {
    return (
      <span title={title} className="try-answer">
        {answer.label} {answer.p.toFixed(2)}
      </span>
    );
  }
  return (
    <span title={title} className="try-answer">
      {answer.p >= 0.5 ? <span className="try-yes">yes {answer.p.toFixed(2)}</span> : `no ${answer.p.toFixed(2)}`}
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
      <pre className="try-code">
        <code>{code}</code>
      </pre>
      <div className="try-code-actions">
        <button
          type="button"
          className="try-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(
              () => setCopied(true),
              () => {},
            );
          }}
        >
          {copied ? 'Copied' : 'Copy the code'}
        </button>
        <Link href="/docs/quickstart" className="try-more">
          How to run it <span aria-hidden="true">→</span>
        </Link>
      </div>
    </>
  );
}
