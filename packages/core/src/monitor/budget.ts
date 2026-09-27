import { DailyBudget } from "../scheduler.js";
import { storeKey, type Store } from "../store/types.js";

/** Input tokens a run may still spend today. */
export interface Budget {
  readonly exhausted: boolean;
  /** Count tokens now; the returned promise settles once the store has them too. */
  spend(tokens: number): void | Promise<void>;
  /** Read today's total from the store before a run starts judging. */
  load?(): Promise<void>;
}

const KEEP_MS = 2 * 86_400_000;

/**
 * Input tokens per UTC day, counted in the store so every process, worker and request shares one
 * total. Spending counts locally at once, so a burst can't overshoot while the store catches up.
 */
export class StoredBudget implements Budget {
  readonly #limit: number;
  readonly #store: Store;
  readonly #parts: string[];
  readonly #now: () => number;
  #day = "";
  #spent = 0;

  constructor(limit: number, store: Store, parts: string[], now: () => number) {
    if (!(limit >= 0)) throw new RangeError(`A daily budget must be zero or more tokens, got ${limit}.`);
    this.#limit = limit;
    this.#store = store;
    this.#parts = parts;
    this.#now = now;
  }

  get exhausted(): boolean {
    this.#roll();
    return this.#spent >= this.#limit;
  }

  async load(): Promise<void> {
    this.#roll();
    const day = this.#day;
    const saved = await this.#store.get(this.#key(day));
    if (this.#day === day && typeof saved === "number") this.#spent = Math.max(this.#spent, saved);
  }

  spend(tokens: number): Promise<void> {
    this.#roll();
    this.#spent += tokens;
    const day = this.#day;
    return this.#store.add(this.#key(day), tokens, { ttlMs: KEEP_MS }).then((total) => {
      if (this.#day === day) this.#spent = Math.max(this.#spent, total);
    });
  }

  #key(day: string): string {
    return storeKey("budget", ...this.#parts, day);
  }

  #roll(): void {
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#spent = 0;
    }
  }
}

/** A `DailyBudget` shared in this process, as a run budget. */
export function sharedBudget(budget: DailyBudget): Budget {
  return {
    get exhausted() {
      return budget.exhausted;
    },
    spend: (tokens) => budget.spend(tokens),
  };
}

/** Exhausted when any of them is; spending counts against all of them. */
export function allOf(budgets: ReadonlyArray<Budget | undefined>): Budget | undefined {
  const list = budgets.filter((budget): budget is Budget => budget !== undefined);
  if (list.length <= 1) return list[0];
  return {
    get exhausted() {
      return list.some((budget) => budget.exhausted);
    },
    spend: async (tokens) => {
      await Promise.all(list.map((budget) => budget.spend(tokens)));
    },
    load: async () => {
      await Promise.all(list.map((budget) => budget.load?.()));
    },
  };
}
