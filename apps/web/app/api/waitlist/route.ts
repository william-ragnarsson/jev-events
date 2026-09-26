// The Jev Events Cloud waitlist on the landing page. Each sign-up is forwarded as JSON
// ({ email, monitor, text }) to WAITLIST_WEBHOOK_URL: a Slack incoming webhook, a Zapier or Make
// hook, or your own endpoint. Without it, the form says the waitlist isn't open yet.
// Emails are never logged.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const { email, monitor } = (body ?? {}) as { email?: unknown; monitor?: unknown };
  if (typeof email !== 'string' || email.length > 254 || !EMAIL.test(email.trim())) {
    return Response.json({ error: 'Enter a valid email address.' }, { status: 400 });
  }
  if (monitor != null && (typeof monitor !== 'string' || monitor.length > 500)) {
    return Response.json({ error: 'Keep your answer under 500 characters.' }, { status: 400 });
  }

  const hook = process.env.WAITLIST_WEBHOOK_URL;
  if (!hook) {
    return Response.json({ error: "The waitlist isn't open yet." }, { status: 503 });
  }

  const entry = { email: email.trim(), monitor: (monitor ?? '').trim() };
  const text = entry.monitor
    ? `New Jev Events Cloud sign-up: ${entry.email}, who'd monitor: ${entry.monitor}`
    : `New Jev Events Cloud sign-up: ${entry.email}`;
  try {
    const res = await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...entry, text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`The waitlist webhook answered ${res.status}`);
  } catch (err) {
    console.error('Waitlist sign-up not forwarded:', err instanceof Error ? err.message : err);
    return Response.json({ error: "Couldn't add you right now." }, { status: 502 });
  }
  return Response.json({ ok: true });
}
