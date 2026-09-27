import type { JsonValue } from "@typesafe-ai/sdk";

import type { Connection, ConnectionStatus } from "../connection.js";
import { encryptionKey, isSealed, seal, unseal, WRONG_KEY_PROBLEM } from "./seal.js";
import type { ConnectionStore, Store } from "./types.js";

/**
 * Anything with a `query(text, values)` method: a `pg` Pool or Client, PGlite, or Neon's
 * `neon(url)`. For postgres.js, pass `{ query: (text, values) => sql.unsafe(text, values) }`.
 */
export interface PostgresClient {
  query(text: string, values?: unknown[]): PromiseLike<unknown>;
}

export interface PostgresStoreOptions {
  /** Encrypts tokens. Defaults to `JEV_EVENTS_KEY`. Generate one with `npx jev-events key`. */
  key?: string;
  /** The schema that holds the two tables. Created when missing. Default "jev_events". */
  schema?: string;
}

type Row = Record<string, unknown>;

const CLEANUP_EVERY_MS = 10 * 60_000;

/**
 * Keeps state and connections in Postgres, in their own schema (`jev_events` by default) with
 * two tables that are created on first use. Safe to share between processes and servers.
 */
export function postgresStore(client: PostgresClient, options: PostgresStoreOptions = {}): Store {
  const schema = options.schema ?? "jev_events";
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new TypeError(`Invalid schema name "${schema}". Use lowercase letters, digits and underscores.`);
  }
  const key = encryptionKey(options.key);
  if (!key) {
    throw new Error(
      "postgresStore needs a key to encrypt tokens. Generate one with `npx jev-events key` and set JEV_EVENTS_KEY to it.",
    );
  }

  const state = `${schema}.state`;
  const table = `${schema}.connections`;
  const ttl = (ms: number | undefined) => (ms === undefined ? null : ms);
  const expiry = "now() + $3::double precision * interval '1 millisecond'";
  let ready: Promise<void> | undefined;
  let lastCleanup = Date.now();

  const query = async (text: string, values: unknown[] = []): Promise<Row[]> => {
    ready ??= migrate().catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    await ready;
    return rows(await client.query(text, values));
  };

  async function migrate(): Promise<void> {
    const statements = [
      ...(schema === "public" ? [] : [`create schema if not exists ${schema}`]),
      `create table if not exists ${state} (
        key text primary key,
        value jsonb not null,
        expires_at timestamptz
      )`,
      `create index if not exists state_expires_at on ${state} (expires_at) where expires_at is not null`,
      `create table if not exists ${table} (
        id text primary key,
        integration text not null,
        user_id text,
        label text,
        credentials text not null,
        facts jsonb,
        status text not null default 'active',
        problem text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      `create index if not exists connections_integration on ${table} (integration)`,
    ];
    for (const statement of statements) {
      try {
        await client.query(statement);
      } catch (error) {
        // Two processes creating the schema at the same moment can collide; the second try sees it.
        await client.query(statement).then(undefined, () => Promise.reject(error));
      }
    }
  }

  const cleanup = () => {
    if (Date.now() - lastCleanup < CLEANUP_EVERY_MS) return;
    lastCleanup = Date.now();
    void query(`delete from ${state} where expires_at < now()`).catch(() => {});
  };

  const open = (row: Row): Connection => {
    const base = {
      id: String(row.id),
      integration: String(row.integration),
      ...(row.user_id == null ? {} : { userId: String(row.user_id) }),
      ...(row.label == null ? {} : { label: String(row.label) }),
      ...(row.facts == null ? {} : { facts: row.facts as { [key: string]: JsonValue } }),
      status: String(row.status) as ConnectionStatus,
      ...(row.problem == null ? {} : { problem: String(row.problem) }),
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
    };
    const sealed = String(row.credentials);
    try {
      return { ...base, credentials: isSealed(sealed) ? unseal(sealed, key) : (JSON.parse(sealed) as Connection["credentials"]) };
    } catch {
      return { ...base, credentials: {}, status: "needs-sign-in", problem: WRONG_KEY_PROBLEM };
    }
  };

  const connections: ConnectionStore = {
    async list(filter) {
      const found = await query(
        `select * from ${table} where ($1::text is null or integration = $1) and ($2::text is null or user_id = $2) order by created_at, id`,
        [filter?.integration ?? null, filter?.userId ?? null],
      );
      return found.map(open);
    },
    async get(id) {
      const [row] = await query(`select * from ${table} where id = $1`, [id]);
      return row ? open(row) : undefined;
    },
    async save(connection) {
      await query(
        `insert into ${table} (id, integration, user_id, label, credentials, facts, status, problem, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, coalesce($9::timestamptz, now()), now())
         on conflict (id) do update set integration = excluded.integration, user_id = excluded.user_id,
           label = excluded.label, credentials = excluded.credentials, facts = excluded.facts,
           status = excluded.status, problem = excluded.problem, updated_at = now()`,
        [
          connection.id,
          connection.integration,
          connection.userId ?? null,
          connection.label ?? null,
          seal(connection.credentials, key),
          connection.facts === undefined ? null : JSON.stringify(connection.facts),
          connection.status ?? "active",
          connection.problem ?? null,
          connection.createdAt ?? null,
        ],
      );
    },
    async update(id, patch) {
      const sets: string[] = ["updated_at = now()"];
      const values: unknown[] = [id];
      const column = { label: "label", facts: "facts", status: "status", problem: "problem", userId: "user_id" } as const;
      for (const [field, value] of Object.entries(patch)) {
        if (field === "credentials") {
          if (value === undefined) continue;
          values.push(seal(value as Connection["credentials"], key));
          sets.push(`credentials = $${values.length}`);
          continue;
        }
        const name = column[field as keyof typeof column];
        if (!name) continue;
        if (field === "status" && value === undefined) {
          sets.push("status = 'active'");
          continue;
        }
        values.push(value === undefined ? null : field === "facts" ? JSON.stringify(value) : value);
        sets.push(`${name} = $${values.length}${field === "facts" ? "::jsonb" : ""}`);
      }
      const [row] = await query(`update ${table} set ${sets.join(", ")} where id = $1 returning *`, values);
      return row ? open(row) : undefined;
    },
    async delete(id) {
      await query(`delete from ${table} where id = $1`, [id]);
    },
  };

  return {
    connections,
    async get(key) {
      const [row] = await query(`select value from ${state} where key = $1 and (expires_at is null or expires_at > now())`, [key]);
      return row ? (row.value as JsonValue) : undefined;
    },
    async set(key, value, options) {
      cleanup();
      await query(
        `insert into ${state} (key, value, expires_at) values ($1, $2::jsonb, ${expiry})
         on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at`,
        [key, JSON.stringify(value), ttl(options?.ttlMs)],
      );
    },
    async delete(key) {
      await query(`delete from ${state} where key = $1`, [key]);
    },
    async claim(key, options) {
      cleanup();
      const claimed = await query(
        `insert into ${state} (key, value, expires_at) values ($1, $2::jsonb, ${expiry})
         on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at
         where ${state}.expires_at is not null and ${state}.expires_at <= now()
         returning key`,
        [key, JSON.stringify(options?.value ?? true), ttl(options?.ttlMs)],
      );
      return claimed.length > 0;
    },
    async add(key, amount, options) {
      const [row] = await query(
        `insert into ${state} (key, value, expires_at) values ($1, to_jsonb($2::double precision), ${expiry})
         on conflict (key) do update set
           value = to_jsonb(
             case when ${state}.expires_at is not null and ${state}.expires_at <= now() then 0
                  else coalesce((${state}.value #>> '{}')::double precision, 0) end + $2::double precision),
           expires_at = excluded.expires_at
         returning value`,
        [key, amount, ttl(options?.ttlMs)],
      );
      return Number(row?.value ?? amount);
    },
  };
}

function rows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  const inner = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(inner) ? (inner as Row[]) : [];
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
