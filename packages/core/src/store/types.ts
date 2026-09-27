import type { JsonValue } from "@typesafe-ai/sdk";

import type { Connection } from "../connection.js";

/**
 * Where monitors keep what has to outlive one process or one request: cursors, which items were
 * already seen, which native actions already ran, budgets, and connections with their tokens.
 *
 * Use `postgresStore` in production, `fileStore` on your own machine and `memoryStore` in tests.
 * To use another database, implement this interface; `claim` and `add` must be atomic.
 */
export interface Store {
  get(key: string): Promise<JsonValue | undefined>;
  /** Save a value. With `ttlMs` it expires after that long. */
  set(key: string, value: JsonValue, options?: { ttlMs?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Save `value` (default `true`) only when the key is missing or expired. Resolves true when this
   * call saved it, so only one of several processes racing for the same key wins.
   */
  claim(key: string, options?: { ttlMs?: number; value?: JsonValue }): Promise<boolean>;
  /** Add to a number (a missing or expired key counts as 0) and resolve with the new total. */
  add(key: string, amount: number, options?: { ttlMs?: number }): Promise<number>;
  readonly connections: ConnectionStore;
  /** Write anything still buffered. The runtime calls this when it stops. */
  flush?(): Promise<void>;
  /** Flush and let go of resources. Call it when you're done with the store. */
  close?(): Promise<void>;
}

export interface ConnectionFilter {
  integration?: string;
  userId?: string;
}

/**
 * The fields `update` can change. A field set to `undefined`, such as `problem`, is cleared;
 * clearing `status` makes the connection "active" again.
 */
export type ConnectionPatch = Partial<Pick<Connection, "label" | "credentials" | "facts" | "status" | "problem" | "userId">>;

/** Signed-in accounts. Tokens are encrypted at rest when the store has a key. */
export interface ConnectionStore {
  /** Connections, oldest first. */
  list(filter?: ConnectionFilter): Promise<Connection[]>;
  get(id: string): Promise<Connection | undefined>;
  /** Create or replace a connection. `createdAt` is kept from the first save. */
  save(connection: Connection): Promise<void>;
  /** Change some fields of a saved connection. Resolves undefined when it doesn't exist. */
  update(id: string, patch: ConnectionPatch): Promise<Connection | undefined>;
  delete(id: string): Promise<void>;
}

/**
 * Build a store key from parts, such as `storeKey("cursor", monitorId, connectionId)`. Parts are
 * joined with "|", and "|" or "%" inside a part are escaped so two different keys never collide.
 */
export function storeKey(...parts: Array<string | number>): string {
  return parts.map((part) => String(part).replaceAll("%", "%25").replaceAll("|", "%7C")).join("|");
}

/** Deep copy through JSON, so callers can't change stored values by mutating what they got. */
export function copy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Apply a patch to a saved record, clearing fields the patch sets to undefined. Credentials are
 * only ever replaced, never cleared; `sealCredentials` turns them into what the store keeps.
 * Values are copied, but not the patch as a whole: that would lose the undefined fields.
 */
export function applyPatch<T extends { updatedAt?: string }>(
  record: T,
  patch: ConnectionPatch,
  now: Date,
  sealCredentials: (credentials: Connection["credentials"]) => unknown = (credentials) => credentials,
): T {
  const next: Record<string, unknown> = { ...record, updatedAt: now.toISOString() };
  for (const [field, value] of Object.entries(patch)) {
    if (field === "credentials") {
      if (value !== undefined) next.credentials = sealCredentials(copy(value as Connection["credentials"]));
    } else if (field === "status" && value === undefined) {
      next.status = "active";
    } else if (value === undefined) {
      delete next[field];
    } else {
      next[field] = copy(value);
    }
  }
  return next as T;
}

export function matches(connection: Connection, filter: ConnectionFilter | undefined): boolean {
  if (filter?.integration !== undefined && connection.integration !== filter.integration) return false;
  if (filter?.userId !== undefined && connection.userId !== filter.userId) return false;
  return true;
}

export function byAge(a: Connection, b: Connection): number {
  return (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id);
}
