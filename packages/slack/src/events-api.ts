import { createHmac, timingSafeEqual } from "node:crypto";

import type { Logger } from "jev-events";

import type { EventCallback } from "./socket.js";

/** Requests signed longer ago than this are refused, so a captured one can't be replayed. */
const MAX_AGE_SECONDS = 5 * 60;

export interface EventsApiOptions {
  /** From your app's Basic Information → App Credentials. */
  signingSecret: string;
  /** Called with each event, once the source has started. */
  deliver?: ((payload: EventCallback) => void) | undefined;
  log: Logger;
  /** The current time in milliseconds. For tests. */
  now?: () => number;
}

/**
 * Answer one request from Slack's Events API: check its signature, answer the URL check, and hand
 * events on. It answers at once, since Slack retries anything that takes longer than 3 seconds.
 */
export async function handleEventsRequest(request: Request, options: EventsApiOptions): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "Slack sends events with POST." });
  const body = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  const now = Math.floor((options.now ?? Date.now)() / 1000);
  if (!/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > MAX_AGE_SECONDS) {
    return json(401, { error: "Missing or stale X-Slack-Request-Timestamp." });
  }
  if (!sameSignature(signature, slackSignature(options.signingSecret, timestamp, body))) {
    return json(401, { error: "Invalid signature. Check the signing secret." });
  }

  let payload: EventCallback & { challenge?: string };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    return json(400, { error: "Invalid JSON." });
  }
  switch (payload.type) {
    case "url_verification":
      return json(200, { challenge: payload.challenge ?? "" });
    case "event_callback":
      // Slack retries a 503, so nothing is lost while the source starts.
      if (!options.deliver) return json(503, { error: "Not started yet." });
      options.deliver(payload);
      return json(200, { ok: true });
    case "app_rate_limited":
      options.log.warn("slack: Slack is dropping events because the app gets more than 30,000 an hour.");
      return json(200, { ok: true });
    default:
      return json(200, { ok: true });
  }
}

/** The `X-Slack-Signature` Slack sends with a body: "v0=" and an HMAC-SHA256 of it. */
export function slackSignature(signingSecret: string, timestamp: string | number, body: string): string {
  return `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

function sameSignature(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
