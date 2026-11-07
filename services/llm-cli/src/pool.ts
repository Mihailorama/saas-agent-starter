import { CliError } from './cli.ts';

/**
 * The subscriptions of one vendor CLI. Each has its own concurrency limit; a request takes the
 * next free one round-robin, waits in a bounded FIFO queue when all are busy, and moves on to
 * another subscription when one answers rate-limited (that one then cools down). When every
 * subscription is cooling down, or the queue is full or its wait times out, the request is
 * refused with `Busy` (HTTP 429), which the gateway may answer with its configured fallback.
 *
 * ponytail: limits live in this process, so run one llm-cli replica; a shared limiter (Redis)
 * when one replica is not enough.
 */
export type Subscription = {
  name: string;
  concurrency: number;
  env: Record<string, string>;
  home: string;
};

export type Limits = { maxQueue: number; queueTimeoutMs: number; cooldownMs: number };

export class Busy extends Error {
  readonly retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class Vendor {
  private next = 0;
  private readonly active = new Map<string, number>();
  private readonly coolUntil = new Map<string, number>();
  private readonly waiters: (() => void)[] = [];
  readonly subs: Subscription[];
  private readonly opts: Limits;
  private readonly now: () => number;

  constructor(subs: Subscription[], opts: Limits, now: () => number = Date.now) {
    this.subs = subs;
    this.opts = opts;
    this.now = now;
  }

  get queued() {
    return this.waiters.length;
  }

  async run<T>(fn: (sub: Subscription) => Promise<T>): Promise<T> {
    const tried = new Set<string>();
    for (;;) {
      const sub = await this.acquire(tried);
      try {
        return await fn(sub);
      } catch (err) {
        if (!(err instanceof CliError && err.kind === 'rate_limited')) throw err;
        this.coolUntil.set(sub.name, this.now() + this.opts.cooldownMs);
        tried.add(sub.name);
      } finally {
        this.release(sub);
      }
    }
  }

  private async acquire(tried: Set<string>): Promise<Subscription> {
    const deadline = this.now() + this.opts.queueTimeoutMs;
    for (;;) {
      const now = this.now();
      const usable = this.subs.filter(
        (s) => !tried.has(s.name) && (this.coolUntil.get(s.name) ?? 0) <= now,
      );
      if (!usable.length) {
        const until = Math.min(...this.subs.map((s) => this.coolUntil.get(s.name) ?? now));
        throw new Busy('every subscription is rate-limited', Math.ceil((until - now) / 1000) || 1);
      }
      for (let i = 0; i < this.subs.length; i++) {
        const sub = this.subs[(this.next + i) % this.subs.length]!;
        if (usable.includes(sub) && (this.active.get(sub.name) ?? 0) < sub.concurrency) {
          this.next = (this.subs.indexOf(sub) + 1) % this.subs.length;
          this.active.set(sub.name, (this.active.get(sub.name) ?? 0) + 1);
          return sub;
        }
      }
      if (this.waiters.length >= this.opts.maxQueue) throw new Busy('queue is full', 1);
      if (!(await this.wait(deadline - now))) throw new Busy('queue wait timed out', 1);
    }
  }

  private release(sub: Subscription) {
    this.active.set(sub.name, (this.active.get(sub.name) ?? 1) - 1);
    this.waiters.shift()?.();
  }

  /** Resolves true when a slot is released, false after `ms`. */
  private wait(ms: number) {
    return new Promise<boolean>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(
        () => {
          const i = this.waiters.indexOf(wake);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(false);
        },
        Math.max(ms, 0),
      );
      this.waiters.push(wake);
    });
  }
}
