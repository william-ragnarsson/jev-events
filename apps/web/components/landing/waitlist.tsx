'use client';

import { useState, type FormEvent } from 'react';

type Status = 'idle' | 'sending' | 'joined' | 'closed' | 'failed';

const MESSAGE: Record<Status, string> = {
  idle: '',
  sending: '',
  joined: "You're on the list. We'll email you when there's something to try.",
  closed: "The waitlist isn't open yet. Check back soon.",
  failed: "Couldn't add you right now. Try again in a bit.",
};

const FIELD =
  'h-10 rounded-lg border border-[var(--line-2)] bg-black/30 px-3 text-[14px] outline-none transition-colors placeholder:text-[var(--dim)] focus:border-[var(--accent)]';

/** The Jev Events Cloud waitlist. Posts to /api/waitlist, which forwards the entry if one is set up. */
export function WaitlistForm() {
  const [status, setStatus] = useState<Status>('idle');

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setStatus('sending');
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: data.get('email'), monitor: data.get('monitor') }),
      });
      setStatus(res.ok ? 'joined' : res.status === 503 ? 'closed' : 'failed');
    } catch {
      setStatus('failed');
    }
  };

  return (
    <form data-reveal onSubmit={submit} className="landing-border-glow flex flex-col rounded-3xl p-8">
      <p className="font-mono text-[11px] tracking-[0.14em] text-[var(--accent)] uppercase">Coming later · Jev Events Cloud</p>
      <h3 className="mt-3 text-[22px] font-semibold tracking-tight">Want us to run your monitors?</h3>
      <p className="mt-2 text-[14px] leading-relaxed text-[var(--muted)]">
        We&apos;d run the webhook routes, scheduled jobs and workers for you, and keep a log of every action. You&apos;d still write the
        monitors. It&apos;s in design now, so tell us what you&apos;d use it for.
      </p>
      {status === 'joined' ? (
        <p aria-live="polite" className="mt-6 rounded-lg border border-[var(--line-2)] bg-black/20 px-4 py-3 text-[14px]">
          {MESSAGE.joined}
        </p>
      ) : (
        <>
          <input name="email" type="email" required maxLength={254} autoComplete="email" aria-label="Email" placeholder="you@company.com" className={`mt-6 ${FIELD}`} />
          <input
            name="monitor"
            maxLength={500}
            autoComplete="off"
            aria-label="What would you monitor? (optional)"
            placeholder="What would you monitor? (optional)"
            className={`mt-2 ${FIELD}`}
          />
          <button
            type="submit"
            disabled={status === 'sending'}
            className="mt-4 h-10 rounded-lg bg-[var(--fg)] text-[14px] font-medium text-[var(--bg)] transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {status === 'sending' ? 'Joining…' : 'Join the waitlist'}
          </button>
          <p aria-live="polite" className="mt-3 min-h-5 text-[13px] text-[var(--muted)]">
            {MESSAGE[status]}
          </p>
        </>
      )}
    </form>
  );
}
