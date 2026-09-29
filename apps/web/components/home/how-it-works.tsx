import type { CSSProperties, ReactNode } from 'react';

import { GmailIcon } from '@/components/brand-icons';
import { HOME_CODE, HOME_MARKS, HOME_STEPS, type Step } from './code';
import './home.css';

/** One Gmail monitor: its code with the parts that matter marked, next to the inbox it watches. */
export function HowItWorks() {
  return (
    <section className="home-section" aria-labelledby="how-title">
      <h2 id="how-title" className="home-heading">
        How it works
      </h2>
      <p className="hiw-lead">
        Dana is one of your users. For each new email in Dana&apos;s inbox, Jev answers your question with a number from 0
        to 1. At 0.85 or more, the monitor adds the label “Reply today”.
      </p>
      <div className="hiw-panels">
        <div className="hiw-col hiw-col-code">
          <CodePanel />
          <p className="hiw-note">
            Monitors start in dry-run. They report what they would do until you set <code>dryRun: false</code>.
          </p>
        </div>
        <div className="hiw-col hiw-col-inbox">
          <Inbox />
          <p className="hiw-note">The monitor checks Dana&apos;s inbox for new email every 15 seconds.</p>
        </div>
      </div>
      <p className="hiw-figures">
        Jev answers in about 200 ms for $0.042 per million input tokens. Output is free. (TypeSafe&apos;s published
        figures.)
      </p>
    </section>
  );
}

// ---------- The code ----------

// The marks light up in step with the inbox: Watch while each email comes in, Ask while Jev answers,
// Act only when the answer is 0.85 or more and the label goes on. The keyframes are in home.css.
function CodePanel() {
  const importsEnd = HOME_CODE.indexOf('\n\n');
  const body = HOME_CODE.slice(importsEnd);
  const parts: ReactNode[] = [];
  let from = 0;
  HOME_MARKS.forEach((mark, i) => {
    const at = body.indexOf(mark.code, from);
    parts.push(body.slice(from, at), <Mark key={i} step={mark.step} code={mark.code} />);
    from = at + mark.code.length;
  });
  parts.push(body.slice(from));

  return (
    <figure className="hiw-code">
      <figcaption className="hiw-bar">monitor.ts</figcaption>
      <div className="hiw-code-body">
        <ol className="hiw-rail">
          {HOME_STEPS.map((step) => (
            <li key={step.step} style={{ '--at': step.line } as CSSProperties}>
              <strong>{step.label}</strong> <span>{step.text}</span>
            </li>
          ))}
        </ol>
        <pre className="hiw-pre">
          <code>
            <span className="hiw-dim">{HOME_CODE.slice(0, importsEnd)}</span>
            {parts}
          </code>
        </pre>
      </div>
    </figure>
  );
}

/** A marked piece of code: a light wash all the time, and a solid copy on top while its step is on. */
function Mark({ step, code }: { step: Step; code: string }) {
  return (
    <span className={`hiw-mark hiw-mark-${step}`}>
      <span className="hiw-mark-text">{code}</span>
      <span className="hiw-mark-lit" aria-hidden="true">
        {code}
      </span>
    </span>
  );
}

// ---------- Dana's inbox ----------

type Email = { from: string; subject: string; snippet: string; score: number };

const MIN = 0.85;
/** Seconds between two emails. The whole loop is ten of them, 40 s. */
const EVERY = 4;
/** How many rows the inbox shows. */
const VISIBLE = 6;

// In the order they arrive. The 1st, 4th and 7th clear 0.85: the Act keyframes in home.css light up
// for those three.
const EMAILS: Email[] = [
  { from: 'Sarah Chen', subject: 'Re: contract redlines', snippet: 'Can you sign off by 5pm? Legal is waiting.', score: 0.93 },
  { from: 'Uber', subject: 'Your Thursday evening trip', snippet: 'Thanks for riding, Dana. Total $18.40', score: 0.02 },
  { from: 'The Weekly Digest', subject: 'Issue #212', snippet: 'Three essays on remote work, and a reading list', score: 0.01 },
  { from: 'Priya Patel', subject: 'Deck for Monday?', snippet: 'Could you send me the latest version tonight?', score: 0.88 },
  { from: 'Northwind Billing', subject: 'Invoice 4471 is ready', snippet: 'No action needed. It will be paid automatically.', score: 0.07 },
  { from: 'GitHub', subject: '[acme/app] PR #1042 merged', snippet: 'Merged into main by marco-r.', score: 0.03 },
  { from: 'Marco Rossi', subject: 'Offsite headcount', snippet: 'Are you coming on the 14th? I need numbers by Friday.', score: 0.91 },
  { from: 'Linear', subject: 'Your weekly summary', snippet: '12 issues closed, 4 opened.', score: 0.02 },
  { from: 'Google Calendar', subject: 'Updated invitation: Q4 planning', snippet: 'Sarah Chen updated the event.', score: 0.12 },
  { from: 'Alex Kim', subject: 'Photos from Saturday', snippet: 'Here are the ones I promised!', score: 0.41 },
];

const INBOX_DESCRIPTION =
  "Dana's inbox. A new email arrives every few seconds and Jev answers with a number from 0 to 1. The emails at 0.85 or more get the label Reply today: Re: contract redlines at 0.93, Deck for Monday? at 0.88 and Offsite headcount at 0.91. The rest are left alone.";

/**
 * Newest first, like Gmail. Each arrival slides the list down one row. Under the oldest row sit
 * still copies of the newest ones, which is what the inbox shows when the loop starts over, so it
 * never jumps. With reduced motion the list stays at the top, every email answered.
 */
function Inbox() {
  const newestFirst = EMAILS.map((email, i) => ({ email, delay: i === 0 ? 0 : i * EVERY - EMAILS.length * EVERY })).reverse();
  return (
    <div className="inbox" role="img" aria-label={INBOX_DESCRIPTION}>
      <div className="hiw-bar">
        <GmailIcon aria-hidden="true" />
        <span>Dana&apos;s inbox</span>
      </div>
      <div className="inbox-columns">
        <span>Email</span>
        <code>needsReply</code>
      </div>
      <div className="inbox-window">
        <div className="inbox-list">
          {newestFirst.map(({ email, delay }) => (
            <Row key={email.subject} email={email} delay={delay} />
          ))}
          {newestFirst.slice(0, VISIBLE).map(({ email }) => (
            <Row key={`still-${email.subject}`} email={email} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** One email. Live rows (with a `delay`) arrive as “New”, then show Jev's answer and, at 0.85 or more, the label. */
function Row({ email, delay }: { email: Email; delay?: number }) {
  const live = delay !== undefined;
  const yes = email.score >= MIN;
  return (
    <div
      className={live ? 'inbox-row is-live' : 'inbox-row'}
      style={live ? ({ '--delay': `${delay}s` } as CSSProperties) : undefined}
    >
      {live && <span className="inbox-wash" />}
      <div className="inbox-row-inner">
        <div className="inbox-text">
          <div className="inbox-from">{email.from}</div>
          <div className="inbox-line">
            {yes && (
              <span className="inbox-label">
                <span>Reply today</span>
              </span>
            )}
            <span className="inbox-subject">{email.subject}</span>
            <span className="inbox-snippet">– {email.snippet}</span>
          </div>
        </div>
        <div className="inbox-answer">
          {live && <span className="inbox-new">New</span>}
          <span className={yes ? 'inbox-score is-yes' : 'inbox-score'}>{email.score.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}
