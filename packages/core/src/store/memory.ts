import type { JsonValue } from "@typesafe-ai/sdk";

import type { Connection } from "../connection.js";
import { applyPatch, byAge, copy, matches, type ConnectionStore, type Store } from "./types.js";

export interface MemoryStoreOptions {
  /** Connections to start with, such as ones built from tokens you already have. */
  connections?: readonly Connection[];
  /** Clock override for tests. */
  now?: () => number;
}

interface Entry {
  value: JsonValue;
  expires: number | undefined;
}

/**
 * Keeps everything in this process. Good for tests and one-off scripts: after a restart, cursors
 * and "already seen" marks are gone, so polling sources start over from new items.
 */
export function memoryStore(options: MemoryStoreOptions = {}): Store {
  const now = options.now ?? Date.now;
  const state = new Map<string, Entry>();
  const saved = new Map<string, Connection>();
  let writes = 0;

  const live = (key: string): Entry | undefined => {
    const entry = state.get(key);
    if (entry?.expires !== undefined && entry.expires <= now()) {
      state.delete(key);
      return undefined;
    }
    return entry;
  };
  const put = (key: string, value: JsonValue, ttlMs: number | undefined) => {
    state.set(key, { value: copy(value), expires: ttlMs === undefined ? undefined : now() + ttlMs });
    if (++writes % 500 === 0) for (const k of [...state.keys()]) live(k);
  };

  const connections: ConnectionStore = {
    async list(filter) {
      return [...saved.values()].filter((c) => matches(c, filter)).sort(byAge).map(copy);
    },
    async get(id) {
      return copy(saved.get(id));
    },
    async save(connection) {
      const at = new Date(now()).toISOString();
      const createdAt = saved.get(connection.id)?.createdAt ?? connection.createdAt ?? at;
      saved.set(connection.id, copy({ ...connection, status: connection.status ?? "active", createdAt, updatedAt: at }));
    },
    async update(id, patch) {
      const existing = saved.get(id);
      if (!existing) return undefined;
      const next = applyPatch(existing, patch, new Date(now()));
      saved.set(id, next);
      return copy(next);
    },
    async delete(id) {
      saved.delete(id);
    },
  };
  for (const connection of options.connections ?? []) void connections.save(connection);

  return {
    connections,
    async get(key) {
      return copy(live(key)?.value);
    },
    async set(key, value, options) {
      put(key, value, options?.ttlMs);
    },
    async delete(key) {
      state.delete(key);
    },
    async claim(key, options) {
      if (live(key)) return false;
      put(key, options?.value ?? true, options?.ttlMs);
      return true;
    },
    async add(key, amount, options) {
      const current = live(key)?.value;
      const total = (typeof current === "number" ? current : 0) + amount;
      put(key, total, options?.ttlMs);
      return total;
    },
  };
}
