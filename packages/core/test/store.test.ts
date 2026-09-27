import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { fileStore, generateKey, memoryStore, postgresStore, storeKey, toConnection, type Connection, type Store } from "../src/index.js";

interface Harness {
  store: Store;
  /** Let `ms` pass, as far as the store's expiry times are concerned. */
  wait(ms: number): Promise<void>;
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jev-events-store-"));
  dirs.push(dir);
  return dir;
}

let db: PGlite;
let schemas = 0;

beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
});

afterAll(async () => {
  await db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  // A key in the developer's environment would change what the stores do with tokens.
  vi.stubEnv("JEV_EVENTS_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A clock the memory and file stores read, moved forward by `wait`. */
function fakeClock(): { now: () => number; wait: (ms: number) => Promise<void> } {
  let now = Date.parse("2026-09-26T12:00:00.000Z");
  return {
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
  };
}

const stores: Record<string, () => Harness> = {
  memoryStore: () => {
    const clock = fakeClock();
    return { store: memoryStore({ now: clock.now }), wait: clock.wait };
  },
  fileStore: () => {
    const clock = fakeClock();
    return { store: fileStore(tempDir(), { now: clock.now }), wait: clock.wait };
  },
  postgresStore: () => ({
    // A schema per test keeps the tests apart in one database. Postgres keeps time itself.
    store: postgresStore(db, { key: generateKey(), schema: `test_${++schemas}` }),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }),
};

const TTL = 50;
const LATER = 150;

function connection(account: string, extra: Partial<Connection> = {}): Connection {
  return { ...toConnection("test", { account, credentials: { token: `token-${account}` } }), ...extra };
}

describe.each(Object.entries(stores))("%s", (_name, open) => {
  let store: Store;
  let wait: Harness["wait"];

  beforeEach(() => {
    ({ store, wait } = open());
  });

  afterEach(async () => {
    await store.close?.();
  });

  describe("state", () => {
    it("gets, sets and deletes JSON values", async () => {
      const value = { nested: { list: [1, "two", null] }, flag: false };
      await store.set("a", value);
      await store.set("n", 42);
      await store.set("s", "text");

      expect(await store.get("a")).toEqual(value);
      expect(await store.get("n")).toBe(42);
      expect(await store.get("s")).toBe("text");
      expect(await store.get("missing")).toBeUndefined();

      await store.set("n", 43);
      expect(await store.get("n")).toBe(43);
      await store.delete("n");
      expect(await store.get("n")).toBeUndefined();
    });

    it("hands out copies, so changing a value doesn't change the store", async () => {
      const value = { list: [1] };
      await store.set("a", value);
      value.list.push(2);
      const read = (await store.get("a")) as { list: number[] };
      read.list.push(3);
      expect(await store.get("a")).toEqual({ list: [1] });
    });

    it("forgets values after their time to live", async () => {
      await store.set("short", "soon gone", { ttlMs: TTL });
      await store.set("long", "kept");
      expect(await store.get("short")).toBe("soon gone");

      await wait(LATER);
      expect(await store.get("short")).toBeUndefined();
      expect(await store.get("long")).toBe("kept");
    });

    it("lets only the first claim of a key win", async () => {
      expect(await store.claim("c")).toBe(true);
      expect(await store.claim("c")).toBe(false);
      expect(await store.get("c")).toBe(true);

      expect(await store.claim("owned", { value: { by: "worker-1" } })).toBe(true);
      expect(await store.get("owned")).toEqual({ by: "worker-1" });

      await store.set("taken", "already here");
      expect(await store.claim("taken")).toBe(false);
    });

    it("lets exactly one of many racing claims win", async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => store.claim("race", { ttlMs: 60_000 })));
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("lets a key be claimed again once its claim expires", async () => {
      expect(await store.claim("lock", { ttlMs: TTL })).toBe(true);
      expect(await store.claim("forever")).toBe(true);
      expect(await store.claim("lock", { ttlMs: TTL })).toBe(false);

      await wait(LATER);
      expect(await store.claim("lock", { ttlMs: TTL })).toBe(true);
      expect(await store.claim("forever")).toBe(false);
    });

    it("adds to numbers, counting missing and expired keys as zero", async () => {
      expect(await store.add("n", 5)).toBe(5);
      expect(await store.add("n", 2.5)).toBe(7.5);
      expect(await store.get("n")).toBe(7.5);

      expect(await store.add("daily", 1, { ttlMs: TTL })).toBe(1);
      expect(await store.add("daily", 1, { ttlMs: TTL })).toBe(2);
      await wait(LATER);
      expect(await store.add("daily", 1, { ttlMs: TTL })).toBe(1);
    });
  });

  describe("connections", () => {
    const ann = connection("ann", { createdAt: "2026-01-01T00:00:00.000Z" });
    const bob = connection("bob", { createdAt: "2026-01-02T00:00:00.000Z" });
    const cy = {
      ...toConnection("slack", { account: "T123", label: "Acme", credentials: { token: "xoxb" } }, { userId: "u2" }),
      createdAt: "2026-01-03T00:00:00.000Z",
    };

    it("saves, lists oldest first, filters and gets connections", async () => {
      await store.connections.save(cy);
      await store.connections.save(bob);
      await store.connections.save(ann);

      const ids = (list: Connection[]) => list.map((c) => c.id);
      expect(ids(await store.connections.list())).toEqual([ann.id, bob.id, cy.id]);
      expect(ids(await store.connections.list({ integration: "test" }))).toEqual([ann.id, bob.id]);
      expect(ids(await store.connections.list({ userId: "u2" }))).toEqual([cy.id]);
      expect(ids(await store.connections.list({ integration: "test", userId: "u2" }))).toEqual([]);

      expect(await store.connections.get(cy.id)).toEqual({
        id: "slack:u2:T123",
        integration: "slack",
        userId: "u2",
        label: "Acme",
        credentials: { token: "xoxb" },
        status: "active",
        createdAt: "2026-01-03T00:00:00.000Z",
        updatedAt: expect.any(String),
      });
      expect(await store.connections.get("test:nobody")).toBeUndefined();
    });

    it("keeps the first createdAt when a connection is saved again", async () => {
      await store.connections.save(ann);
      await store.connections.save({ ...ann, label: "Ann A.", createdAt: "2030-01-01T00:00:00.000Z" });

      expect(await store.connections.get(ann.id)).toMatchObject({ label: "Ann A.", createdAt: "2026-01-01T00:00:00.000Z" });
      expect(await store.connections.list()).toHaveLength(1);
    });

    it("fills in createdAt, updatedAt and the active status", async () => {
      const { createdAt: _createdAt, updatedAt: _updatedAt, status: _status, ...bare } = connection("dee");
      await store.connections.save(bare);

      const saved = await store.connections.get(bare.id);
      expect(saved?.status).toBe("active");
      expect(Date.parse(saved?.createdAt ?? "")).not.toBeNaN();
      expect(Date.parse(saved?.updatedAt ?? "")).not.toBeNaN();
    });

    it("updates some fields, clearing the ones set to undefined", async () => {
      await store.connections.save(ann);

      const broken = await store.connections.update(ann.id, { status: "needs-sign-in", problem: "Google revoked access" });
      expect(broken).toMatchObject({ status: "needs-sign-in", problem: "Google revoked access", credentials: { token: "token-ann" } });
      expect(await store.connections.get(ann.id)).toMatchObject({ status: "needs-sign-in", problem: "Google revoked access" });

      const fixed = await store.connections.update(ann.id, {
        status: "active",
        problem: undefined,
        credentials: { token: "new" },
        facts: { timeZone: "Europe/Stockholm" },
        userId: "u1",
      });
      expect(fixed).not.toHaveProperty("problem");
      expect(fixed).toMatchObject({ status: "active", credentials: { token: "new" }, facts: { timeZone: "Europe/Stockholm" }, userId: "u1" });

      const cleared = await store.connections.update(ann.id, { credentials: undefined, facts: undefined, label: undefined, status: undefined });
      expect(cleared).toMatchObject({ status: "active", credentials: { token: "new" } });
      expect(cleared).not.toHaveProperty("facts");
      expect(cleared).not.toHaveProperty("label");
      expect(await store.connections.get(ann.id)).toEqual(cleared);

      expect(await store.connections.update("test:nobody", { status: "paused" })).toBeUndefined();
      expect(await store.connections.get("test:nobody")).toBeUndefined();
    });

    it("deletes connections", async () => {
      await store.connections.save(ann);
      await store.connections.save(bob);
      await store.connections.delete(ann.id);

      expect(await store.connections.get(ann.id)).toBeUndefined();
      expect((await store.connections.list()).map((c) => c.id)).toEqual([bob.id]);
    });

    it("hands out copies of connections", async () => {
      await store.connections.save(ann);
      const read = await store.connections.get(ann.id);
      if (read) read.credentials.token = "changed";
      expect((await store.connections.get(ann.id))?.credentials).toEqual({ token: "token-ann" });
    });
  });
});

describe("storeKey", () => {
  it("joins parts so that different parts never make the same key", () => {
    expect(storeKey("seen", "inbox", "google:ann@acme.com", 42)).toBe("seen|inbox|google:ann@acme.com|42");
    expect(storeKey("a|b", "100%")).toBe("a%7Cb|100%25");
    expect(storeKey("a|b", "c")).not.toBe(storeKey("a", "b|c"));
    expect(storeKey("a%7Cb")).not.toBe(storeKey("a|b"));
  });
});

describe("fileStore", () => {
  it("keeps state and connections in a private file that git ignores", async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    await store.set("cursor", { historyId: "123" });
    await store.connections.save(connection("ann"));
    await store.close?.();

    const file = join(dir, "store.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("*\n");

    const again = fileStore(dir);
    expect(await again.get("cursor")).toEqual({ historyId: "123" });
    expect((await again.connections.get("test:ann"))?.credentials).toEqual({ token: "token-ann" });
    await again.close?.();
  });

  it("returns the same store for the same folder", async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    expect(fileStore(dir)).toBe(store);
    await store.close?.();
    expect(fileStore(dir)).not.toBe(store);
  });

  it("writes claims to disk right away", async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    expect(await store.claim("action|m|c|item|flag")).toBe(true);
    expect(readFileSync(join(dir, "store.json"), "utf8")).toContain("action|m|c|item|flag");
    await store.close?.();
  });

  it("keeps changes from another process that writes the same file", async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    await store.set("mine", 1);
    await store.flush?.();
    // Another process, such as the CLI, saves a connection meanwhile.
    const data = JSON.parse(readFileSync(join(dir, "store.json"), "utf8")) as { connections: Record<string, unknown> };
    data.connections["test:bob"] = { ...connection("bob") };
    writeFileSync(join(dir, "store.json"), JSON.stringify(data));

    await store.set("mine", 2);
    await store.flush?.();
    expect((await store.connections.get("test:bob"))?.label).toBe("bob");
    expect(await store.get("mine")).toBe(2);
    await store.close?.();
  });

  it("saves tokens as plain text without a key", async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    await store.connections.save(connection("ann"));
    await store.close?.();
    expect(readFileSync(join(dir, "store.json"), "utf8")).toContain("token-ann");
  });

  it("encrypts tokens with a key, and says what to do when the key is missing or wrong", async () => {
    const dir = tempDir();
    const key = generateKey();
    const store = fileStore(dir, { key });
    await store.connections.save(connection("ann"));
    await store.close?.();
    expect(readFileSync(join(dir, "store.json"), "utf8")).not.toContain("token-ann");

    const same = fileStore(dir, { key });
    expect((await same.connections.get("test:ann"))?.credentials).toEqual({ token: "token-ann" });
    await same.close?.();

    const keyless = fileStore(dir);
    expect(await keyless.connections.get("test:ann")).toMatchObject({
      credentials: {},
      status: "needs-sign-in",
      problem: "its tokens are encrypted; set JEV_EVENTS_KEY to the key they were saved with",
    });
    await keyless.close?.();

    const wrong = fileStore(dir, { key: generateKey() });
    expect(await wrong.connections.get("test:ann")).toMatchObject({
      credentials: {},
      status: "needs-sign-in",
      problem: "couldn't decrypt its tokens with this JEV_EVENTS_KEY; sign in again",
    });
    await wrong.close?.();
  });

  it("uses JEV_EVENTS_KEY when no key is passed", async () => {
    const dir = tempDir();
    vi.stubEnv("JEV_EVENTS_KEY", generateKey());
    const store = fileStore(dir);
    await store.connections.save(connection("ann"));
    await store.close?.();
    expect(readFileSync(join(dir, "store.json"), "utf8")).not.toContain("token-ann");
  });

  it("says how to recover from a file it can't read", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "store.json"), "{ not json");
    const store = fileStore(dir);
    await expect(store.get("anything")).rejects.toThrow(/Couldn't read .*store\.json: .* Move the file away to start fresh\./);
    expect(existsSync(join(dir, "store.json"))).toBe(true);
    await store.close?.();
  });
});

describe("postgresStore", () => {
  it("needs a key to encrypt tokens", () => {
    expect(() => postgresStore(db)).toThrow(/postgresStore needs a key to encrypt tokens. Generate one with `npx jev-events key`/);
    vi.stubEnv("JEV_EVENTS_KEY", generateKey());
    expect(() => postgresStore(db)).not.toThrow();
  });

  it("only accepts plain schema names", () => {
    expect(() => postgresStore(db, { key: generateKey(), schema: "jev; drop table users" })).toThrow(TypeError);
    expect(() => postgresStore(db, { key: generateKey(), schema: "Jev" })).toThrow(/Invalid schema name "Jev"/);
  });

  it("creates its tables in its own schema on first use", async () => {
    const store = postgresStore(db, { key: generateKey(), schema: "jev_first_use" });
    await store.set("hello", "world");
    const tables = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'jev_first_use' order by table_name",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(["connections", "state"]);
  });

  it("always encrypts tokens, and marks connections it can't decrypt", async () => {
    const key = generateKey();
    const store = postgresStore(db, { key, schema: "jev_sealed" });
    await store.connections.save(connection("ann"));
    const raw = await db.query<{ credentials: string }>("select credentials from jev_sealed.connections");
    expect(raw.rows[0]?.credentials).toMatch(/^v1:/);
    expect(raw.rows[0]?.credentials).not.toContain("token-ann");

    const wrong = postgresStore(db, { key: generateKey(), schema: "jev_sealed" });
    expect(await wrong.connections.get("test:ann")).toMatchObject({
      credentials: {},
      status: "needs-sign-in",
      problem: "couldn't decrypt its tokens with this JEV_EVENTS_KEY; sign in again",
    });
  });

  it("works with clients that return rows as an array, such as Neon's", async () => {
    const neonLike = { query: async (text: string, values?: unknown[]) => (await db.query(text, values)).rows };
    const store = postgresStore(neonLike, { key: generateKey(), schema: "jev_neon" });
    await store.connections.save(connection("ann"));
    expect(await store.claim("k")).toBe(true);
    expect(await store.claim("k")).toBe(false);
    expect(await store.add("n", 2)).toBe(2);
    expect((await store.connections.list()).map((c) => c.id)).toEqual(["test:ann"]);
  });
});
