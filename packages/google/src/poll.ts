import type { Item, SourceContext } from "jev-events";

import { isFatal } from "./api.js";

/**
 * Run `check` right away, then every `every` milliseconds until the listener stops. Errors are
 * reported and the next check still runs, except fatal ones (signed out, access removed), which stop
 * the listener.
 */
export function poll<I extends Item>(ctx: SourceContext<I>, every: number, check: (first: boolean) => Promise<void>): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (first: boolean) => {
    try {
      await check(first);
    } catch (error) {
      if (ctx.signal.aborted) return;
      const fatal = isFatal(error);
      ctx.fail(error, { fatal });
      if (fatal) return;
    }
    if (!ctx.signal.aborted) timer = setTimeout(() => void tick(false), every);
  };
  ctx.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  timer = setTimeout(() => void tick(true), 0);
}
