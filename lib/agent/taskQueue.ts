// Parallel tasks: at most N agent runs use the model at once. Running several
// tasks multiplies requests, and free tiers limit requests per minute, so
// extra tasks wait here, oldest first, and start as others finish. Workflow
// replays don't call the model, so they don't wait. Background only.

/** A waiting task was stopped before it got a slot. */
export class TaskCancelled extends Error {
  constructor() {
    super('Stopped before it started');
    this.name = 'TaskCancelled';
  }
}

interface Waiter {
  tabId: number;
  go: () => void;
  cancel: () => void;
}

export class TaskQueue {
  private running = 0;
  private waiting: Waiter[] = [];

  constructor(
    /** How many may run at once (read each time, so a settings change applies). */
    private limit: () => Promise<number> | number,
    /** Told a tab's place in the queue (1 = next), or 0 when it stops waiting. */
    private onPosition: (tabId: number, position: number) => void = () => {},
  ) {}

  get active(): number {
    return this.running;
  }

  /** Tabs waiting for a slot, next first. */
  get queued(): number[] {
    return this.waiting.map((w) => w.tabId);
  }

  /** Run `job` once a slot is free; resolves with its result. Rejects with TaskCancelled if cancelled while waiting. */
  async run<T>(tabId: number, job: () => Promise<T>): Promise<T> {
    // Read the limit first: in `running >= await limit()`, `running` is read before
    // the await, so every task started together would see an empty queue
    const limit = Math.max(1, await this.limit());
    // One waiting task per tab: a new one replaces it. After the await, so a task
    // added a moment earlier has joined the queue by now and can be found
    this.cancel(tabId);
    if (this.running >= limit) {
      await new Promise<void>((resolve, reject) => {
        this.waiting.push({ tabId, go: resolve, cancel: () => reject(new TaskCancelled()) });
        this.positions();
      });
    }
    this.running++;
    this.onPosition(tabId, 0);
    try {
      return await job();
    } finally {
      this.running--;
      await this.next();
    }
  }

  /** Stop a task that's still waiting. True if there was one. */
  cancel(tabId: number): boolean {
    const i = this.waiting.findIndex((w) => w.tabId === tabId);
    if (i < 0) return false;
    const [waiter] = this.waiting.splice(i, 1);
    waiter.cancel();
    this.onPosition(tabId, 0);
    this.positions();
    return true;
  }

  private positions(): void {
    this.waiting.forEach((w, i) => this.onPosition(w.tabId, i + 1));
  }

  private async next(): Promise<void> {
    const limit = Math.max(1, await this.limit());
    // Hand out the free slots; each started job counts itself in run()
    let free = limit - this.running;
    while (free-- > 0 && this.waiting.length) {
      this.waiting.shift()!.go();
    }
    this.positions();
  }
}
