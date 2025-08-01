import { Logger } from "./logger";

export class PerformanceMonitor {
  private logger: Logger;
  private timers: Map<string, Timer>;

  constructor(logger: Logger) {
    this.logger = logger;
    this.timers = new Map();
  }

  startTimer(name: string): Timer {
    const timer = new Timer(name, this.logger);
    this.timers.set(name, timer);
    timer.start();
    return timer;
  }

  stopTimer(name: string): void {
    const timer = this.timers.get(name);
    if (timer) {
      timer.stop();
      this.timers.delete(name);
    }
  }

  dispose(): void {
    // Stoppe alle Timer wenn nötig
    for (const timer of this.timers.values()) {
      timer.stop();
    }
    this.timers.clear();
  }
}

export class Timer {
  private name: string;
  private logger: Logger;
  private startTime: [number, number] | null = null;
  private endTime: [number, number] | null = null;
  private durationMs: number | null = null;

  constructor(name: string, logger: Logger) {
    this.name = name;
    this.logger = logger;
  }

  start(): void {
    this.startTime = process.hrtime();
  }

  stop(): void {
    if (!this.startTime) {
      this.logger.warn(`Timer "${this.name}" stopped without being started.`);
      return;
    }
    this.endTime = process.hrtime(this.startTime);
    this.durationMs = this.endTime[0] * 1000 + this.endTime[1] / 1e6;
    this.logger.debug(
      `Timer "${this.name}" took ${this.durationMs.toFixed(2)} ms.`
    );
  }

  getDuration(): number {
    if (this.durationMs !== null) {
      return this.durationMs;
    }
    if (this.startTime) {
      const diff = process.hrtime(this.startTime);
      return diff[0] * 1000 + diff[1] / 1e6;
    }
    return 0;
  }
}
