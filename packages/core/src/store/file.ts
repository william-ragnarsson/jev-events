import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { JsonValue } from "@typesafe-ai/sdk";

import type { Connection, Credentials } from "../connection.js";
import { encryptionKey, isSealed, NO_KEY_PROBLEM, seal, unseal, WRONG_KEY_PROBLEM } from "./seal.js";
import { applyPatch, byAge, copy, matches, type ConnectionStore, type Store } from "./types.js";

export interface FileStoreOptions {
  /**
   * Encrypt tokens with this key. Defaults to `JEV_EVENTS_KEY`. Without a key, tokens are saved
   * as plain text in a file only your user can read.
   */
  key?: string;
  /** Clock override for tests. */
  now?: () => number;
}

interface Entry {
  value: JsonValue;
  expires?: number;
}

type SavedConnection = Omit<Connection, "credentials"> & { credentials: Credentials | string };

interface FileData {
  version: 1;
  state: Record<string, Entry>;
  connections: Record<string, SavedConnection>;
}

const FILE = "store.json";
const WRITE_DELAY_MS = 100;
const instances = new Map<string, FileStore>();
const unsaved = new Set<FileStore>();
let exitHooked = false;

/**
 * Keeps everything in one JSON file in `dir` (default `.jev-events`), which is what the CLI uses.
 * The folder is private to your user and ignored by git.
 *
 * Meant for one process at a time on your own machine, plus the CLI. When several processes or
 * servers run monitors, use `postgresStore`.
 */
export function fileStore(dir = ".jev-events", options: FileStoreOptions = {}): Store {
  const path = resolve(dir);
  const id = `${path}\0${options.key ?? ""}`;
  let store = instances.get(id);
  if (!store) {
    store = new FileStore(path, options, () => instances.delete(id));
    instances.set(id, store);
  }
  return store;
}

class FileStore implements Store {
  readonly connections: ConnectionStore;
  readonly #dir: string;
  readonly #file: string;
  readonly #key: Buffer | undefined;
  readonly #now: () => number;
  readonly #forget: () => void;
  /** State as this process sees it, read from the file once. */
  #state: Map<string, Entry> | undefined;
  /** Keys set or deleted here since the last write. */
  readonly #dirty = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(dir: string, options: FileStoreOptions, forget: () => void) {
    this.#dir = dir;
    this.#file = join(dir, FILE);
    this.#key = encryptionKey(options.key);
    this.#now = options.now ?? Date.now;
    this.#forget = forget;
    this.connections = {
      list: async (filter) =>
        Object.values(this.#read().connections)
          .map((saved) => this.#open(saved))
          .filter((c) => matches(c, filter))
          .sort(byAge),
      get: async (id) => {
        const saved = this.#read().connections[id];
        return saved ? this.#open(saved) : undefined;
      },
      save: async (connection) => {
        const at = new Date(this.#now()).toISOString();
        this.#write((data) => {
          const createdAt = data.connections[connection.id]?.createdAt ?? connection.createdAt ?? at;
          data.connections[connection.id] = {
            ...copy(connection),
            credentials: this.#seal(connection.credentials),
            status: connection.status ?? "active",
            createdAt,
            updatedAt: at,
          };
        });
      },
      update: async (id, patch) => {
        let updated: Connection | undefined;
        this.#write((data) => {
          const saved = data.connections[id];
          if (!saved) return;
          const next = applyPatch(saved, patch, new Date(this.#now()), (credentials) => this.#seal(credentials));
          data.connections[id] = next;
          updated = this.#open(next);
        });
        return updated;
      },
      delete: async (id) => {
        this.#write((data) => {
          delete data.connections[id];
        });
      },
    };
  }

  async get(key: string): Promise<JsonValue | undefined> {
    return copy(this.#live(key)?.value);
  }

  async set(key: string, value: JsonValue, options?: { ttlMs?: number }): Promise<void> {
    this.#put(key, value, options?.ttlMs);
    this.#later();
  }

  async delete(key: string): Promise<void> {
    this.#load().delete(key);
    this.#dirty.add(key);
    this.#later();
  }

  async claim(key: string, options?: { ttlMs?: number; value?: JsonValue }): Promise<boolean> {
    if (this.#live(key)) return false;
    this.#put(key, options?.value ?? true, options?.ttlMs);
    // Claims guard "at most once", so they reach the disk before anything acts on them.
    this.#write();
    return true;
  }

  async add(key: string, amount: number, options?: { ttlMs?: number }): Promise<number> {
    const current = this.#live(key)?.value;
    const total = (typeof current === "number" ? current : 0) + amount;
    this.#put(key, total, options?.ttlMs);
    this.#later();
    return total;
  }

  async flush(): Promise<void> {
    this.flushSync();
  }

  async close(): Promise<void> {
    this.flushSync();
    this.#forget();
  }

  flushSync(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#dirty.size > 0) this.#write();
  }

  #load(): Map<string, Entry> {
    this.#state ??= new Map(Object.entries(this.#read().state));
    return this.#state;
  }

  #live(key: string): Entry | undefined {
    const state = this.#load();
    const entry = state.get(key);
    if (entry?.expires !== undefined && entry.expires <= this.#now()) {
      state.delete(key);
      this.#dirty.add(key);
      return undefined;
    }
    return entry;
  }

  #put(key: string, value: JsonValue, ttlMs: number | undefined): void {
    this.#load().set(key, ttlMs === undefined ? { value: copy(value) } : { value: copy(value), expires: this.#now() + ttlMs });
    this.#dirty.add(key);
  }

  #later(): void {
    unsaved.add(this);
    hookExit();
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      try {
        this.flushSync();
      } catch {
        // Tried again on the next write, on flush and at exit.
      }
    }, WRITE_DELAY_MS);
    this.#timer.unref?.();
  }

  #read(): FileData {
    let text: string;
    try {
      text = readFileSync(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, state: {}, connections: {} };
      throw error;
    }
    let data: Partial<FileData>;
    try {
      data = JSON.parse(text) as Partial<FileData>;
    } catch (error) {
      throw new Error(`Couldn't read ${this.#file}: ${(error as Error).message}. Move the file away to start fresh.`);
    }
    return { version: 1, state: data.state ?? {}, connections: data.connections ?? {} };
  }

  /** Read the file, apply this process's changes and `change`, and replace the file in one step. */
  #write(change?: (data: FileData) => void): void {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const ignore = join(this.#dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");

    const data = this.#read();
    const state = this.#state;
    if (state) {
      for (const key of this.#dirty) {
        const entry = state.get(key);
        if (entry) data.state[key] = entry;
        else delete data.state[key];
      }
    }
    this.#dirty.clear();
    unsaved.delete(this);
    const now = this.#now();
    for (const [key, entry] of Object.entries(data.state)) {
      if (entry.expires !== undefined && entry.expires <= now) delete data.state[key];
    }
    change?.(data);

    const temporary = `${this.#file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#file);
  }

  #seal(credentials: Credentials): Credentials | string {
    return this.#key ? seal(credentials, this.#key) : copy(credentials);
  }

  #open(saved: SavedConnection): Connection {
    const { credentials, ...rest } = copy(saved);
    if (!isSealed(credentials)) return { ...rest, credentials: credentials as Credentials };
    if (!this.#key) return { ...rest, credentials: {}, status: "needs-sign-in", problem: NO_KEY_PROBLEM };
    try {
      return { ...rest, credentials: unseal(credentials, this.#key) };
    } catch {
      return { ...rest, credentials: {}, status: "needs-sign-in", problem: WRONG_KEY_PROBLEM };
    }
  }
}

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.once("exit", () => {
    for (const store of unsaved) {
      try {
        store.flushSync();
      } catch {
        // Nothing more can be done while exiting.
      }
    }
  });
}
