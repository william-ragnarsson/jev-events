import { TokenBucket } from "../scheduler.js";

export interface RateOptions {
  /** Sustained requests per second. Default 18, under Jev's 1,200 requests per minute. */
  perSecond?: number;
  /** Requests allowed at once after a quiet period. Default 20. */
  burst?: number;
  /** Requests in flight at once. Default 16. */
  concurrency?: number;
}

/** A request rate and a number of requests in flight, shared by everything that draws from it. */
export class Limiter {
  readonly bucket: TokenBucket;
  readonly concurrency: number;
  inflight = 0;

  constructor(rate: RateOptions = {}, now: () => number = () => Date.now()) {
    this.bucket = new TokenBucket(rate.perSecond ?? 18, rate.burst ?? 20, now);
    this.concurrency = rate.concurrency ?? 16;
  }

  get full(): boolean {
    return this.inflight >= this.concurrency;
  }
}

/** Items waiting for a request, such as one monitor's run for one connection. */
export interface Lane {
  /** The limit of the lane's monitor, on top of the runtime's. */
  readonly limiter: Limiter | undefined;
  /** Drop items that can't be judged any more from the front, and say whether one is waiting. */
  ready(): boolean;
  /** Judge the front item. `done` must be called once the request settles. */
  begin(done: () => void): void;
}

/**
 * Hands out request slots. Lanes take turns, so one busy connection can't starve the others, and
 * no lane goes over its monitor's limit or the runtime's.
 */
export class Scheduler {
  readonly limiter: Limiter;
  readonly #now: () => number;
  #lanes: Lane[] = [];
  #next = 0;
  #pumping = false;
  #again = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #due = Number.POSITIVE_INFINITY;

  constructor(limiter: Limiter, now: () => number = () => Date.now()) {
    this.limiter = limiter;
    this.#now = now;
  }

  add(lane: Lane): void {
    if (!this.#lanes.includes(lane)) this.#lanes.push(lane);
  }

  remove(lane: Lane): void {
    const index = this.#lanes.indexOf(lane);
    if (index === -1) return;
    this.#lanes.splice(index, 1);
    if (this.#next > index) this.#next--;
    if (this.#lanes.length === 0) this.stop();
  }

  /** Start as many requests as the limits allow. Safe to call at any time. */
  pump(): void {
    if (this.#pumping) {
      this.#again = true;
      return;
    }
    this.#pumping = true;
    try {
      do {
        this.#again = false;
        this.#round();
      } while (this.#again);
    } finally {
      this.#pumping = false;
    }
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#due = Number.POSITIVE_INFINITY;
  }

  #round(): void {
    const global = this.limiter;
    let wait = Number.POSITIVE_INFINITY;
    while (!global.full) {
      const lanes = this.#lanes;
      let started = false;
      for (let offset = 0; offset < lanes.length; offset++) {
        const index = (this.#next + offset) % lanes.length;
        const lane = lanes[index] as Lane;
        const own = lane.limiter;
        if (own?.full) continue;
        const ownWait = own?.bucket.msUntilNext() ?? 0;
        if (ownWait > 0) {
          if (lane.ready()) wait = Math.min(wait, ownWait);
          continue;
        }
        if (!lane.ready()) continue;
        const globalWait = global.bucket.msUntilNext();
        if (globalWait > 0) {
          this.#schedule(globalWait);
          return;
        }
        global.bucket.tryTake();
        own?.bucket.tryTake();
        global.inflight++;
        if (own) own.inflight++;
        this.#next = (index + 1) % lanes.length;
        let settled = false;
        lane.begin(() => {
          if (settled) return;
          settled = true;
          global.inflight--;
          if (own) own.inflight--;
          this.pump();
        });
        started = true;
        break;
      }
      if (!started) break;
    }
    if (wait < Number.POSITIVE_INFINITY) this.#schedule(wait);
  }

  #schedule(ms: number): void {
    const delay = Math.max(1, ms);
    const due = this.#now() + delay;
    if (this.#timer && this.#due <= due) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#due = due;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#due = Number.POSITIVE_INFINITY;
      this.pump();
    }, delay);
  }
}
