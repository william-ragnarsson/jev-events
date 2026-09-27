/** A JSON response. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** A small page for people who land on a sign-in route in their browser. */
export function page(status: number, message: string): Response {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jev Events</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: #fbfbfa; color: #1b1b1a; }
  main { max-width: 32rem; padding: 3rem 1.5rem; }
  p { margin: 0; }
  small { display: block; margin-top: 0.75rem; color: #6b6b68; }
  @media (prefers-color-scheme: dark) { body { background: #151515; color: #ececea; } small { color: #9a9a96; } }
</style>
</head>
<body><main><p>${escapeHtml(message)}</p><small>Jev Events</small></main></body>
</html>
`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** The bearer token of a request, if it has one. */
export function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}
