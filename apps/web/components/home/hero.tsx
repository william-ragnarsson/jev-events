import type { CSSProperties } from 'react';

import { Ctas } from './ctas';
import './home.css';

const QUESTION = 'Does this email need a reply today?';
const DESCRIPTION =
  'New emails ride in on a track and pass Jev, who asks: does this email need a reply today? At 0.85 or more a switch sends the email to the other track, where it gets the label Reply today. The rest carry on and are left alone.';

type Email = {
  subject: string;
  score: string;
  yes: boolean;
  /** Where the email is on the desktop tracks when the page loads, in `--u`. */
  wide: [x: number, y: number];
  /** Where it is in the phone's chute when the page loads, in `--m`. */
  tall: [x: number, y: number];
};

// Eight emails spaced evenly along the track, 384u apart on desktop (a 48 s loop at 64u a second)
// and 96m apart on phones (a 24 s loop at 32m a second). The animations start from these positions,
// and with reduced motion the emails stay there. The keyframes are in home.css.
const EMAILS: Email[] = [
  { subject: 'Deck for Monday?', score: '0.88', yes: true, wide: [304.8, 0], tall: [0, 60] },
  { subject: 'Invoice 4471 is ready', score: '0.07', yes: false, wide: [688.8, 0], tall: [0, 156] },
  { subject: 'Re: contract redlines', score: '0.93', yes: true, wide: [1072.8, -101.56], tall: [33.29, 252] },
  { subject: 'The Weekly Digest #212', score: '0.01', yes: false, wide: [1456.8, 0], tall: [0, 348] },
  { subject: 'Offsite headcount', score: '0.91', yes: true, wide: [1840.8, -200], tall: [88, 444] },
  { subject: 'Coffee next week?', score: '0.62', yes: false, wide: [2224.8, 0], tall: [0, 540] },
  { subject: 'Can you approve the PO?', score: '0.90', yes: true, wide: [2608.8, -200], tall: [88, 636] },
  { subject: 'PR #1042 merged', score: '0.03', yes: false, wide: [2992.8, 0], tall: [0, 732] },
];

export function Hero() {
  return (
    <section className="hero on-field" aria-labelledby="hero-title">
      <div className="hero-body">
        <h1 id="hero-title" className="hero-title">
          Ask every event a question.
        </h1>
        <div className="hero-foot">
          <p className="hero-lead">
            A developer-first library to have Jev integrated into your users&apos; inbox, calendar, Slack channels and
            more!
          </p>
          <Ctas />
        </div>
        <Tracks />
        <Chute />
      </div>
    </section>
  );
}

/** Desktop: the emails ride in from the left, and a switch past Jev sends the ones that need a reply up. */
function Tracks() {
  return (
    <div className="tracks" role="img" aria-label={DESCRIPTION}>
      <svg className="tracks-lines" viewBox="0 0 3000 864" aria-hidden="true">
        <path d="M0 624 H720" className="track" strokeWidth="6" />
        <path d="M720 624 H3000" className="track track-faint" strokeWidth="3" />
        <path d="M720 624 C820 624 820 424 920 424 H3000" className="track" strokeWidth="6" />
      </svg>
      <div className="tracks-window tracks-in">
        {EMAILS.map((email) => (
          <span key={email.subject} className={chip('tracks-chip', email)} style={wide(email)}>
            {email.subject}
          </span>
        ))}
      </div>
      <div className="tracks-window tracks-out">
        {EMAILS.map((email) => (
          <span key={email.subject} className={chip('tracks-chip', email)} style={wide(email)}>
            <span>{email.subject}</span>
            <span className="tracks-score">{email.score}</span>
          </span>
        ))}
      </div>
      <span className="tracks-bar" />
      <span className="tracks-jev">Jev</span>
      <span className="tracks-question">{QUESTION}</span>
      <span className="tracks-label tracks-label-yes">0.85 or more → label “Reply today”</span>
      <span className="tracks-label tracks-label-no">Under 0.85 → left alone</span>
      <span className="tracks-label tracks-label-new">New emails →</span>
    </div>
  );
}

/** Phones and tablets: the same, turned on its side. The emails drop in, and the ones that need a reply shift over. */
function Chute() {
  return (
    <div className="chute-wrap" role="img" aria-label={DESCRIPTION}>
      <p className="chute-question">{QUESTION}</p>
      <p className="chute-new">New emails ↓</p>
      <div className="chute">
        <svg className="chute-lines" viewBox="0 0 320 410" aria-hidden="true">
          <path d="M116 0 V190" className="track" strokeWidth="4" />
          <path d="M116 190 V410" className="track track-faint" strokeWidth="2" />
          <path d="M116 190 C116 238 204 238 204 286 V410" className="track" strokeWidth="4" />
        </svg>
        <div className="chute-window chute-in">
          {EMAILS.map((email) => (
            <span key={email.subject} className={chip('chute-chip', email)} style={tall(email)}>
              {email.subject}
            </span>
          ))}
        </div>
        <div className="chute-window chute-out">
          {EMAILS.map((email) => (
            <span key={email.subject} className={chip('chute-chip', email)} style={tall(email)}>
              <span>{email.subject}</span>
              <span className="chute-score">{email.score}</span>
            </span>
          ))}
        </div>
        <span className="chute-bar" />
        <span className="chute-jev">Jev</span>
      </div>
      <ul className="chute-legend">
        <li className="chute-legend-yes">0.85 or more → label “Reply today”</li>
        <li className="chute-legend-no">Under 0.85 → left alone</li>
      </ul>
    </div>
  );
}

function chip(base: string, email: Email) {
  return email.yes ? `${base} is-yes` : `${base} is-no`;
}

function wide({ wide: [x, y] }: Email) {
  return { '--x': x, '--y': y, animationDelay: `${-x / 64}s` } as CSSProperties;
}

function tall({ tall: [x, y] }: Email) {
  return { '--x': x, '--y': y, animationDelay: `${-y / 32}s` } as CSSProperties;
}
