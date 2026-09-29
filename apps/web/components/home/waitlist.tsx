'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

type Status = 'idle' | 'sending' | 'joined' | 'invalid' | 'closed' | 'failed';

const MESSAGE: Record<Status, string> = {
  idle: '',
  sending: '',
  joined: "You're on the list. We'll email you when there's something to try.",
  invalid: 'Check your email address.',
  closed: "The waitlist isn't open yet. Check back soon.",
  failed: "Couldn't add you right now. Try again in a bit.",
};

/** What /api/waitlist's error codes mean. Anything else is a failure. */
const ERRORS: Record<number, Status> = { 400: 'invalid', 503: 'closed' };

/**
 * The hosted monitors waitlist, folded into one line until it's opened. Posts to /api/waitlist,
 * which forwards the entry if one is set up.
 */
export function Waitlist() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const email = useRef<HTMLInputElement>(null);
  const panel = useId();

  useEffect(() => {
    if (open) email.current?.focus();
  }, [open]);

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
      setStatus(res.ok ? 'joined' : (ERRORS[res.status] ?? 'failed'));
    } catch {
      setStatus('failed');
    }
  };

  return (
    <div className="waitlist">
      <p>
        Rather not run it yourself? Hosted monitors are coming.{' '}
        <button
          type="button"
          className="waitlist-toggle"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen((was) => !was)}
        >
          Join the waitlist →
        </button>
      </p>
      <div id={panel} className="waitlist-panel" hidden={!open}>
        {status === 'joined' ? (
          <p className="waitlist-status" role="status">
            {MESSAGE.joined}
          </p>
        ) : (
          <form className="waitlist-form" onSubmit={submit}>
            <input
              ref={email}
              name="email"
              type="email"
              required
              maxLength={254}
              autoComplete="email"
              aria-label="Email"
              placeholder="you@company.com"
            />
            <input
              name="monitor"
              maxLength={500}
              autoComplete="off"
              aria-label="What would you monitor? (optional)"
              placeholder="What would you monitor? (optional)"
            />
            <button type="submit" disabled={status === 'sending'}>
              {status === 'sending' ? 'Joining…' : 'Join the waitlist'}
            </button>
            <p className="waitlist-status" aria-live="polite">
              {MESSAGE[status]}
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
