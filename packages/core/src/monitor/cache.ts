/**
 * Answers for recent text, so a copy-paste flood costs one request. Text is compared ignoring case
 * and repeated spaces. Failed requests are forgotten so the next copy is judged again.
 */
export class TextCache<T> {
  readonly #entries = new Map<string, { value: Promise<T>; expires: number }>();
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;

  constructor(ttlMs: number, max: number, now: () => number) {
    this.#ttlMs = ttlMs;
    this.#max = max;
    this.#now = now;
  }

  get(text: string): Promise<T> | undefined {
    const key = normalize(text);
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expires < this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(text: string, value: Promise<T>): void {
    const key = normalize(text);
    this.#entries.delete(key);
    this.#entries.set(key, { value, expires: this.#now() + this.#ttlMs });
    if (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    value.catch(() => {
      if (this.#entries.get(key)?.value === value) this.#entries.delete(key);
    });
  }
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
