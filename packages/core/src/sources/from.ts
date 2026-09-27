import { randomUUID } from "node:crypto";

import type { JsonValue } from "@typesafe-ai/sdk";

import type { Author, Item, Source } from "../types.js";

/** A plain string, or the parts of an item you have. Missing ids and timestamps are filled in. */
export type ItemInput =
  | string
  | {
      id?: string;
      text: string;
      author?: Author | string;
      at?: Date | string | number;
      facts?: Record<string, JsonValue>;
      raw?: unknown;
    };

export function toItem(input: ItemInput): Item {
  if (typeof input === "string") return { id: randomUUID(), text: input, at: new Date() };
  const author = typeof input.author === "string" ? { id: input.author, name: input.author } : input.author;
  return {
    id: input.id ?? randomUUID(),
    text: input.text,
    ...(author ? { author } : {}),
    at: input.at === undefined ? new Date() : new Date(input.at),
    ...(input.facts ? { facts: input.facts } : {}),
    ...(input.raw === undefined ? {} : { raw: input.raw }),
  };
}

export interface FromOptions<T> {
  id?: string;
  /** What one item is called in Jev's state. Default "item". */
  noun?: string;
  /** Turn each value into an item; return null to skip it. */
  map?: (value: T) => ItemInput | null | undefined;
  /** Preceding items to show Jev as context. Default 0. */
  recent?: number;
}

/**
 * A source over any iterable or async iterable: an array, a generator, a readline interface,
 * a database cursor. The source ends when the iterable does.
 */
export function from<T = ItemInput>(
  values: Iterable<T> | AsyncIterable<T>,
  options: FromOptions<T> = {},
): Source<Item, "custom"> {
  const map = options.map ?? ((value: T) => value as unknown as ItemInput);
  return {
    id: options.id ?? "custom:from",
    platform: "custom",
    noun: options.noun ?? "item",
    defaults: { recent: options.recent ?? 0 },
    start(ctx) {
      void (async () => {
        try {
          for await (const value of values) {
            if (ctx.signal.aborted) return;
            const input = map(value);
            if (input != null) await ctx.emit(toItem(input));
          }
          ctx.end();
        } catch (error) {
          ctx.fail(error, { fatal: true });
        }
      })();
    },
  };
}
