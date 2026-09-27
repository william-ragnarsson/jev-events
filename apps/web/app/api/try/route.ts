// The Try it page (/try) reads a Twitch chat in the browser and sends each message here, with the
// visitor's own TypeSafe key. This forwards it to Jev as a monitor on `twitchChat()` would,
// because TypeSafe's API doesn't accept calls from other sites' pages. Keys are only passed on:
// never logged or stored.

import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
} from '@typesafe-ai/sdk';

import recipes from '@/generated/recipes.json';
import type { RecipeEntry } from '@/lib/builder/generate';
import { jevRequest, parseTryRequest, type TryAnswer, type TryError, type TryResult } from '@/lib/try/jev';

const KEY = /^[\x21-\x7e]{1,256}$/;
const MAX_BODY = 8_000;

const fail = (error: string, status: number, extra: Omit<TryError, 'error'> = {}) => Response.json({ error, ...extra } satisfies TryError, { status });

export async function POST(request: Request) {
  const key = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1]?.trim();
  if (!key || !KEY.test(key)) return fail('Enter your TypeSafe API key.', 401);

  const raw = await request.text().catch(() => '');
  if (raw.length > MAX_BODY) return fail('That message is too long to send.', 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const parsed = parseTryRequest(body);
  if (typeof parsed === 'string') return fail(parsed, 400);
  const ask = jevRequest(parsed, recipes as RecipeEntry[]);
  if (!ask) return fail("That question isn't one of the chat recipes.", 400);

  const client = new TypeSafeClient({
    apiKey: key,
    retry: { maxRetries: 0 },
    timeout: 8_000,
    logLevel: 'off',
  });

  const started = Date.now();
  try {
    const result = await client.systemOne(ask, { signal: request.signal });
    const answer = Object.values(result.answers)[0];
    let shown: TryAnswer;
    if (answer?.type === 'noul') shown = { type: 'noul', p: answer.noul };
    else if (answer?.type === 'choice') shown = { type: 'choice', label: answer.choice, p: answer.confidence };
    else return fail("Jev answered in a way this demo doesn't show.", 502);
    return Response.json({
      answer: shown,
      model: result.model,
      inputTokens: result.usage.input_tokens,
      latencyMs: Date.now() - started,
    } satisfies TryResult);
  } catch (error) {
    if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
      return fail("TypeSafe didn't accept that key. Check it on typesafe.ai and try again.", error.status);
    }
    if (error instanceof RateLimitError) {
      return fail('TypeSafe asked to slow down.', 429, error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {});
    }
    if (error instanceof APIUserAbortError) return fail('Stopped.', 499);
    if (error instanceof APIConnectionError) return fail("Couldn't reach TypeSafe in time.", 504);
    if (error instanceof APIError) return fail(`TypeSafe answered ${error.status}.`, 502);
    console.error('Try it:', String(error instanceof Error ? error.message : error).replaceAll(key, '[key]'));
    return fail('Something went wrong asking Jev.', 500);
  }
}
