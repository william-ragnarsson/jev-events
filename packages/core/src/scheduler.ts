/** A token bucket: `perSecond` sustained, up to `burst` at once. */
export class TokenBucket {
  #tokens: number;
  #last: number;
  readonly #perSecond: number;
  readonly #burst: number;
  readonly #now: () => number;

  constructor(perSecond: number, burst: number, now: () => number = Date.now) {
    this.#perSecond = perSecond;
    this.#burst = Math.max(1, burst);
    this.#tokens = this.#burst;
    this.#now = now;
    this.#last = now();
  }

  tryTake(): boolean {
    if (this.#perSecond === Number.POSITIVE_INFINITY) return true;
    this.#refill();
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }

  /** Milliseconds until a token is available. */
  msUntilNext(): number {
    if (this.#perSecond === Number.POSITIVE_INFINITY) return 0;
    this.#refill();
    return this.#tokens >= 1 ? 0 : Math.ceil(((1 - this.#tokens) / this.#perSecond) * 1000);
  }

  #refill(): void {
    const now = this.#now();
    this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#last) / 1000) * this.#perSecond);
    this.#last = now;
  }
}

/** Keeps the most recent samples and reports percentiles. */
export class Percentiles {
  readonly #samples: number[] = [];
  readonly #size: number;

  constructor(size = 500) {
    this.#size = size;
  }

  add(value: number): void {
    this.#samples.push(value);
    if (this.#samples.length > this.#size) this.#samples.shift();
  }

  at(p: number): number | null {
    if (this.#samples.length === 0) return null;
    const sorted = [...this.#samples].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index] ?? null;
  }
}

/**
 * Input tokens spent per UTC day. Pass one instance as `budget` to several listeners to cap
 * them together, e.g. when a service switches channels.
 */
export class DailyBudget {
  #day = "";
  #spent = 0;
  readonly limit: number;
  readonly #now: () => number;

  constructor(limit: number, now: () => number = Date.now) {
    if (!(limit >= 0)) throw new RangeError(`A daily budget must be zero or more tokens, got ${limit}.`);
    this.limit = limit;
    this.#now = now;
  }

  /** Input tokens spent today (UTC). */
  get spent(): number {
    this.#roll();
    return this.#spent;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.spent);
  }

  get exhausted(): boolean {
    return this.spent >= this.limit;
  }

  spend(tokens: number): void {
    this.#roll();
    this.#spent += tokens;
  }

  #roll(): void {
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#spent = 0;
    }
  }
}
