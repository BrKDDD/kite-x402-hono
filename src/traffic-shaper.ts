/**
 * Traffic Shaper and Priority Queue Coordinator
 * Manages burst smoothing, prioritized execution, and concurrency control for x402 endpoints.
 */

export interface QueuedRequest<T = any> {
  id: string;
  priority: number; // Higher number = higher priority
  timestamp: number;
  execute: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
}

export interface TrafficShaperConfig {
  maxConcurrency: number;
  maxQueueDepth: number;
  defaultPriority?: number;
  queueTimeoutMs?: number;
}

export class TrafficShaper {
  private activeCount: number = 0;
  private queue: QueuedRequest[] = [];
  private readonly config: Required<TrafficShaperConfig>;

  constructor(config: TrafficShaperConfig) {
    this.config = {
      maxConcurrency: config.maxConcurrency,
      maxQueueDepth: config.maxQueueDepth,
      defaultPriority: config.defaultPriority ?? 10,
      queueTimeoutMs: config.queueTimeoutMs ?? 30000,
    };
  }

  public get stats() {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      capacity: this.config.maxConcurrency,
      maxQueue: this.config.maxQueueDepth,
    };
  }

  public async schedule<T>(
    fn: () => Promise<T>,
    priority?: number,
  ): Promise<T> {
    const prio = priority ?? this.config.defaultPriority;

    if (this.activeCount < this.config.maxConcurrency) {
      this.activeCount++;
      try {
        return await fn();
      } finally {
        this.activeCount--;
        this.processNext();
      }
    }

    if (this.queue.length >= this.config.maxQueueDepth) {
      throw new Error(
        `TrafficShaper queue overflow (depth: ${this.queue.length})`,
      );
    }

    return new Promise<T>((resolve, reject) => {
      const item: QueuedRequest<T> = {
        id: Math.random().toString(36).substring(2, 9),
        priority: prio,
        timestamp: Date.now(),
        execute: fn,
        resolve,
        reject,
      };

      // Insert sorted by priority descending
      const insertIdx = this.queue.findIndex((q) => q.priority < prio);
      if (insertIdx === -1) {
        this.queue.push(item);
      } else {
        this.queue.splice(insertIdx, 0, item);
      }

      if (this.config.queueTimeoutMs > 0) {
        setTimeout(() => {
          const idx = this.queue.indexOf(item);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            reject(
              new Error(
                `TrafficShaper request queued timeout (${this.config.queueTimeoutMs}ms)`,
              ),
            );
          }
        }, this.config.queueTimeoutMs);
      }
    });
  }

  private async processNext() {
    if (
      this.activeCount >= this.config.maxConcurrency ||
      this.queue.length === 0
    ) {
      return;
    }

    const nextItem = this.queue.shift();
    if (!nextItem) return;

    this.activeCount++;
    try {
      const res = await nextItem.execute();
      nextItem.resolve(res);
    } catch (err) {
      nextItem.reject(err);
    } finally {
      this.activeCount--;
      this.processNext();
    }
  }
}
