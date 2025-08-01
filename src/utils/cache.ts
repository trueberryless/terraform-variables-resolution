import { Logger } from "./logger";

interface CacheEntry {
  value: string;
  timestamp: number;
  accessCount: number;
  lastAccessed: number;
}

export class TerraformCache {
  private cache = new Map<string, CacheEntry>();
  private readonly TTL = 60000; // 60 seconds TTL
  private readonly MAX_SIZE = 1000; // Maximum cache entries
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(private logger: Logger) {
    this.startCleanupTimer();
  }

  get(key: string): string | null {
    try {
      const entry = this.cache.get(key);
      if (!entry) {
        return null;
      }

      const now = Date.now();

      // Check if entry has expired
      if (now - entry.timestamp > this.TTL) {
        this.cache.delete(key);
        this.logger.debug(`Cache entry expired: ${key}`);
        return null;
      }

      // Update access statistics
      entry.accessCount++;
      entry.lastAccessed = now;

      this.logger.debug(`Cache hit: ${key}`);
      return entry.value;
    } catch (error) {
      this.logger.error(`Error getting cache entry: ${key}`, error);
      return null;
    }
  }

  set(key: string, value: string): void {
    try {
      // Check cache size limit
      if (this.cache.size >= this.MAX_SIZE) {
        this.evictLeastRecentlyUsed();
      }

      const now = Date.now();
      const entry: CacheEntry = {
        value,
        timestamp: now,
        accessCount: 1,
        lastAccessed: now,
      };

      this.cache.set(key, entry);
      this.logger.debug(`Cache set: ${key}`);
    } catch (error) {
      this.logger.error(`Error setting cache entry: ${key}`, error);
    }
  }

  invalidateFile(filePath: string): void {
    try {
      let deletedCount = 0;

      for (const [key] of this.cache) {
        if (key.includes(filePath)) {
          this.cache.delete(key);
          deletedCount++;
        }
      }

      if (deletedCount > 0) {
        this.logger.debug(
          `Invalidated ${deletedCount} cache entries for file: ${filePath}`
        );
      }
    } catch (error) {
      this.logger.error(
        `Error invalidating cache for file: ${filePath}`,
        error
      );
    }
  }

  clear(): void {
    try {
      const size = this.cache.size;
      this.cache.clear();
      this.logger.info(`Cache cleared, removed ${size} entries`);
    } catch (error) {
      this.logger.error("Error clearing cache", error);
    }
  }

  size(): number {
    return this.cache.size;
  }

  getStats(): {
    size: number;
    hitRate: number;
    oldestEntry: number;
    newestEntry: number;
  } {
    const now = Date.now();
    let totalAccess = 0;
    let oldestTimestamp = now;
    let newestTimestamp = 0;

    for (const entry of this.cache.values()) {
      totalAccess += entry.accessCount;
      oldestTimestamp = Math.min(oldestTimestamp, entry.timestamp);
      newestTimestamp = Math.max(newestTimestamp, entry.timestamp);
    }

    const avgAccessPerEntry =
      this.cache.size > 0 ? totalAccess / this.cache.size : 0;

    return {
      size: this.cache.size,
      hitRate: Math.round(avgAccessPerEntry * 100) / 100,
      oldestEntry: now - oldestTimestamp,
      newestEntry: now - newestTimestamp,
    };
  }

  dispose(): void {
    try {
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }

      this.clear();
      this.logger.debug("Cache disposed");
    } catch (error) {
      this.logger.error("Error disposing cache", error);
    }
  }

  private startCleanupTimer(): void {
    // Run cleanup every 5 minutes
    this.cleanupInterval = setInterval(
      () => {
        this.cleanup();
      },
      5 * 60 * 1000
    );
  }

  private cleanup(): void {
    try {
      const now = Date.now();
      let expiredCount = 0;

      for (const [key, entry] of this.cache) {
        if (now - entry.timestamp > this.TTL) {
          this.cache.delete(key);
          expiredCount++;
        }
      }

      if (expiredCount > 0) {
        this.logger.debug(`Cleaned up ${expiredCount} expired cache entries`);
      }
    } catch (error) {
      this.logger.error("Error during cache cleanup", error);
    }
  }

  private evictLeastRecentlyUsed(): void {
    try {
      let lruKey: string | null = null;
      let lruTimestamp = Date.now();

      for (const [key, entry] of this.cache) {
        if (entry.lastAccessed < lruTimestamp) {
          lruTimestamp = entry.lastAccessed;
          lruKey = key;
        }
      }

      if (lruKey) {
        this.cache.delete(lruKey);
        this.logger.debug(`Evicted LRU cache entry: ${lruKey}`);
      }
    } catch (error) {
      this.logger.error("Error during LRU eviction", error);
    }
  }
}
