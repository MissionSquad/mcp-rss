import { CacheEntry, FeedResult } from '../types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export class FeedCache {
  private cache: Map<string, CacheEntry> = new Map();
  private accessOrder: string[] = [];
  private cleanupInterval?: NodeJS.Timeout;
  
  constructor() {
    // Start cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, config.rssCacheCleanupInterval);
  }
  
  /**
   * Get a cached feed if available and not expired
   */
  get(url: string): FeedResult | null {
    const entry = this.cache.get(url);
    if (!entry) return null;
    
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(url);
      this.removeFromAccessOrder(url);
      return null;
    }
    
    // Update access order (LRU)
    this.updateAccessOrder(url);
    
    return entry.data;
  }
  
  /**
   * Get cache metadata without the full data
   */
  getMetadata(url: string): { etag?: string; lastModified?: string } | null {
    const entry = this.cache.get(url);
    if (!entry) return null;
    
    return {
      etag: entry.etag,
      lastModified: entry.lastModified,
    };
  }
  
  /**
   * Store a feed in cache
   */
  set(url: string, data: FeedResult, ttl?: number): void {
    const expiresAt = Date.now() + (ttl || config.rssCacheTTL);
    
    this.cache.set(url, {
      data,
      expiresAt,
      etag: data.etag,
      lastModified: data.lastModified,
    });
    
    this.updateAccessOrder(url);
    
    // Enforce max cache size
    if (this.cache.size > config.rssCacheMaxSize) {
      this.evictLRU();
    }
    
    logger.debug(`Cached feed: ${url}, expires at: ${new Date(expiresAt).toISOString()}`);
  }
  
  /**
   * Update existing cache entry with new data
   */
  update(url: string, data: FeedResult): void {
    const existing = this.cache.get(url);
    if (existing) {
      existing.data = data;
      existing.etag = data.etag;
      existing.lastModified = data.lastModified;
      logger.debug(`Updated cached feed: ${url}`);
    }
  }
  
  /**
   * Check if a feed is cached (regardless of expiration)
   */
  has(url: string): boolean {
    return this.cache.has(url);
  }
  
  /**
   * Remove a feed from cache
   */
  delete(url: string): void {
    this.cache.delete(url);
    this.removeFromAccessOrder(url);
  }
  
  /**
   * Clear all cached feeds
   */
  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
    logger.info('Feed cache cleared');
  }
  
  /**
   * Get cache statistics
   */
  getStats(): { size: number; urls: string[] } {
    return {
      size: this.cache.size,
      urls: Array.from(this.cache.keys()),
    };
  }
  
  /**
   * Clean up expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;
    
    for (const [url, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(url);
        this.removeFromAccessOrder(url);
        removed++;
      }
    }
    
    if (removed > 0) {
      logger.debug(`Cleaned up ${removed} expired cache entries`);
    }
  }
  
  /**
   * Update LRU access order
   */
  private updateAccessOrder(url: string): void {
    this.removeFromAccessOrder(url);
    this.accessOrder.push(url);
  }
  
  /**
   * Remove from access order array
   */
  private removeFromAccessOrder(url: string): void {
    const index = this.accessOrder.indexOf(url);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
  }
  
  /**
   * Evict least recently used entry
   */
  private evictLRU(): void {
    if (this.accessOrder.length > 0) {
      const url = this.accessOrder[0];
      this.delete(url);
      logger.debug(`Evicted LRU cache entry: ${url}`);
    }
  }
  
  /**
   * Destroy cache and clear intervals
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.clear();
  }
}

// Singleton instance
export const feedCache = new FeedCache();
