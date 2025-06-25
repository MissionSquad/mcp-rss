# MCP-RSS Server Engineering Implementation Plan

## Phase 1: Core RSS Functionality Implementation

### 1. Project Structure

```
mcp-rss/
├── src/
│   ├── index.ts           # Main server entry point
│   ├── config.ts          # Configuration management
│   ├── types.ts           # TypeScript type definitions
│   ├── logger.ts          # Logging utility
│   ├── services/
│   │   ├── rss-reader.ts  # RSS fetching and parsing service
│   │   └── cache.ts       # In-memory cache implementation
│   ├── utils/
│   │   ├── content.ts     # Content cleaning utilities
│   │   ├── date.ts        # Date conversion utilities
│   │   └── http.ts        # HTTP request utilities
│   └── storage/
│       └── feed-store.ts  # Optional file-based persistence
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

### 2. Type Definitions (types.ts)

```typescript
// Core RSS Feed Types
export interface FeedItem {
  id: string
  title: string | null
  url: string | null
  content: string | null
  description: string | null
  published: number | null  // epoch milliseconds
  updated: number | null    // epoch milliseconds
  author: string | null
  categories: string[]
  enclosures: Enclosure[]
  guid: string | null
}

export interface Enclosure {
  url: string
  type: string | null
  length: number | null
}

export interface FeedInfo {
  title: string | null
  description: string | null
  url: string | null
  feedUrl: string
  language: string | null
  copyright: string | null
  published: number | null  // epoch milliseconds
  updated: number | null    // epoch milliseconds
  categories: string[]
  author: string | null
  image: {
    url: string | null
    title: string | null
  } | null
}

export interface FeedResult {
  info: FeedInfo
  items: FeedItem[]
  fetchedAt: number  // epoch milliseconds
  etag?: string
  lastModified?: string
}

export interface FeedError {
  url: string
  error: string
  code?: string
  timestamp: number
}

export interface MultiFeedResult {
  url: string
  success: boolean
  data?: FeedResult
  error?: FeedError
}

export interface CacheEntry {
  data: FeedResult
  expiresAt: number
  etag?: string
  lastModified?: string
}

export interface FeedMetadata {
  url: string
  title: string | null
  lastFetchedAt: number
  itemCount: number
  settings: {
    useDescriptionAsContent?: boolean
    cacheTTL?: number  // Override default TTL in milliseconds
  }
}

// Tool Parameter Types
export interface FetchRssFeedParams {
  url: string
  useDescriptionAsContent?: boolean
}

export interface FetchMultipleFeedsParams {
  urls: string[]
  parallel?: boolean
}

export interface MonitorFeedUpdatesParams {
  url: string
  since: number | 'last'
}

export interface SearchFeedItemsParams {
  feeds: string[]
  query: string
  searchIn?: 'title' | 'description' | 'content' | 'all'
}

export interface ExtractFeedContentParams {
  url: string
  format?: 'markdown' | 'text' | 'html'
  includeMetadata?: boolean
}
```

### 3. Configuration (config.ts)

```typescript
import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const ConfigSchema = z.object({
  // Cache settings
  rssCacheTTL: z.number().min(0).default(900000), // 15 minutes in ms
  rssMaxItemsPerFeed: z.number().min(1).default(100),
  
  // HTTP settings
  rssRequestTimeout: z.number().min(1000).default(30000), // 30 seconds
  rssMaxConcurrentFetches: z.number().min(1).default(5),
  rssUserAgent: z.string().default('MCP-RSS/1.0.0'),
  rssFollowRedirects: z.boolean().default(true),
  rssMaxResponseSize: z.number().default(10 * 1024 * 1024), // 10MB
  
  // Storage settings
  rssStoragePath: z.string().optional(),
  rssEnablePersistence: z.boolean().default(false),
  
  // Cache management
  rssCacheMaxSize: z.number().default(100), // Max number of feeds in cache
  rssCacheCleanupInterval: z.number().default(300000), // 5 minutes
  
  // Rate limiting
  rssRateLimitPerMinute: z.number().default(60),
  
  // Logging
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export const config = ConfigSchema.parse({
  rssCacheTTL: process.env.RSS_CACHE_TTL ? parseInt(process.env.RSS_CACHE_TTL) : undefined,
  rssMaxItemsPerFeed: process.env.RSS_MAX_ITEMS_PER_FEED ? parseInt(process.env.RSS_MAX_ITEMS_PER_FEED) : undefined,
  rssRequestTimeout: process.env.RSS_REQUEST_TIMEOUT ? parseInt(process.env.RSS_REQUEST_TIMEOUT) : undefined,
  rssMaxConcurrentFetches: process.env.RSS_MAX_CONCURRENT_FETCHES ? parseInt(process.env.RSS_MAX_CONCURRENT_FETCHES) : undefined,
  rssUserAgent: process.env.RSS_USER_AGENT,
  rssFollowRedirects: process.env.RSS_FOLLOW_REDIRECTS === 'false' ? false : true,
  rssMaxResponseSize: process.env.RSS_MAX_RESPONSE_SIZE ? parseInt(process.env.RSS_MAX_RESPONSE_SIZE) : undefined,
  rssStoragePath: process.env.RSS_STORAGE_PATH,
  rssEnablePersistence: process.env.RSS_ENABLE_PERSISTENCE === 'true',
  rssCacheMaxSize: process.env.RSS_CACHE_MAX_SIZE ? parseInt(process.env.RSS_CACHE_MAX_SIZE) : undefined,
  rssCacheCleanupInterval: process.env.RSS_CACHE_CLEANUP_INTERVAL ? parseInt(process.env.RSS_CACHE_CLEANUP_INTERVAL) : undefined,
  rssRateLimitPerMinute: process.env.RSS_RATE_LIMIT_PER_MINUTE ? parseInt(process.env.RSS_RATE_LIMIT_PER_MINUTE) : undefined,
  logLevel: process.env.LOG_LEVEL as any,
})

export type Config = z.infer<typeof ConfigSchema>
```

### 4. RSS Reader Service (services/rss-reader.ts)

```typescript
import { parseFeed } from '@rowanmanning/feed-parser'
import { Feed } from '@rowanmanning/feed-parser/lib/feed/base'
import { FeedItem as RSSFeedItem } from '@rowanmanning/feed-parser/lib/feed/item/base'
import { FeedResult, FeedInfo, FeedItem, Enclosure } from '../types.js'
import { httpClient } from '../utils/http.js'
import { toEpochMs } from '../utils/date.js'
import { extractCleanContent, sanitizeString } from '../utils/content.js'
import { logger } from '../logger.js'
import { config } from '../config.js'

export class RSSReader {
  /**
   * Fetches raw RSS feed data from a URL
   */
  async fetchRawFeed(url: string, etag?: string, lastModified?: string): Promise<{
    data: string
    etag?: string
    lastModified?: string
    notModified: boolean
  }> {
    logger.debug(`Fetching RSS feed from: ${url}`)
    
    const headers: Record<string, string> = {
      'User-Agent': config.rssUserAgent,
      'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    }
    
    if (etag) {
      headers['If-None-Match'] = etag
    }
    if (lastModified) {
      headers['If-Modified-Since'] = lastModified
    }
    
    try {
      const response = await httpClient.get(url, {
        headers,
        timeout: config.rssRequestTimeout,
        maxRedirects: config.rssFollowRedirects ? 5 : 0,
        responseType: 'text',
        maxContentLength: config.rssMaxResponseSize,
      })
      
      if (response.status === 304) {
        logger.debug(`Feed not modified: ${url}`)
        return { data: '', notModified: true }
      }
      
      return {
        data: response.data,
        etag: response.headers.etag,
        lastModified: response.headers['last-modified'],
        notModified: false,
      }
    } catch (error: any) {
      logger.error(`Error fetching RSS feed from ${url}: ${error.message}`)
      throw new Error(`Failed to fetch RSS feed: ${error.message}`)
    }
  }
  
  /**
   * Parses RSS feed XML into structured data
   */
  async parseFeed(xml: string): Promise<Feed | null> {
    try {
      return parseFeed(xml)
    } catch (error: any) {
      logger.error(`Error parsing RSS feed: ${error.message}`)
      return null
    }
  }
  
  /**
   * Formats parsed feed into our internal structure
   */
  formatFeed(feed: Feed, feedUrl: string, useDescriptionAsContent?: boolean): FeedResult {
    const feedJson = feed.toJSON()
    const { items: _, ...feedMeta } = feedJson
    
    // Extract feed info
    const info: FeedInfo = {
      title: feedMeta.title || null,
      description: feedMeta.description || null,
      url: feedMeta.url || null,
      feedUrl,
      language: feedMeta.language || null,
      copyright: feedMeta.copyright || null,
      published: toEpochMs(feedMeta.published),
      updated: toEpochMs(feedMeta.updated),
      categories: feedMeta.categories?.map((c: any) => c.label || c) || [],
      author: feedMeta.author || null,
      image: feedMeta.image ? {
        url: feedMeta.image.url || null,
        title: feedMeta.image.title || null,
      } : null,
    }
    
    // Format items
    const items: FeedItem[] = feed.items
      .slice(0, config.rssMaxItemsPerFeed)
      .map((item: RSSFeedItem) => {
        const itemJson = item.toJSON()
        
        // Clean content and description
        let content = itemJson.content || null
        let description = itemJson.description || null
        
        if (content) {
          content = extractCleanContent(content).text
        }
        if (description) {
          description = extractCleanContent(description).text
        }
        
        // Handle useDescriptionAsContent option
        if (useDescriptionAsContent && description) {
          content = description
        }
        
        // Extract enclosures
        const enclosures: Enclosure[] = itemJson.enclosures?.map((enc: any) => ({
          url: enc.url,
          type: enc.type || null,
          length: enc.length ? parseInt(enc.length) : null,
        })) || []
        
        return {
          id: sanitizeString(itemJson.guid || itemJson.url || itemJson.title || ''),
          title: itemJson.title || null,
          url: itemJson.url || null,
          content,
          description,
          published: toEpochMs(itemJson.published),
          updated: toEpochMs(itemJson.updated),
          author: itemJson.author || null,
          categories: itemJson.categories?.map((c: any) => c.label || c) || [],
          enclosures,
          guid: itemJson.guid || null,
        }
      })
    
    return {
      info,
      items,
      fetchedAt: Date.now(),
    }
  }
  
  /**
   * Complete feed fetching and parsing pipeline
   */
  async fetchFeed(
    url: string,
    options?: {
      useDescriptionAsContent?: boolean
      etag?: string
      lastModified?: string
    }
  ): Promise<FeedResult> {
    // Fetch raw feed
    const { data, etag, lastModified, notModified } = await this.fetchRawFeed(
      url,
      options?.etag,
      options?.lastModified
    )
    
    if (notModified) {
      throw new Error('NOT_MODIFIED')
    }
    
    // Parse feed
    const parsed = await this.parseFeed(data)
    if (!parsed) {
      throw new Error('Failed to parse feed XML')
    }
    
    // Format feed
    const result = this.formatFeed(parsed, url, options?.useDescriptionAsContent)
    
    // Add cache headers if available
    if (etag) result.etag = etag
    if (lastModified) result.lastModified = lastModified
    
    return result
  }
}

// Singleton instance
export const rssReader = new RSSReader()
```

### 5. Cache Service (services/cache.ts)

```typescript
import { CacheEntry, FeedResult } from '../types.js'
import { config } from '../config.js'
import { logger } from '../logger.js'

export class FeedCache {
  private cache: Map<string, CacheEntry> = new Map()
  private accessOrder: string[] = []
  private cleanupInterval?: NodeJS.Timeout
  
  constructor() {
    // Start cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanup()
    }, config.rssCacheCleanupInterval)
  }
  
  /**
   * Get a cached feed if available and not expired
   */
  get(url: string): FeedResult | null {
    const entry = this.cache.get(url)
    if (!entry) return null
    
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(url)
      this.removeFromAccessOrder(url)
      return null
    }
    
    // Update access order (LRU)
    this.updateAccessOrder(url)
    
    return entry.data
  }
  
  /**
   * Get cache metadata without the full data
   */
  getMetadata(url: string): { etag?: string; lastModified?: string } | null {
    const entry = this.cache.get(url)
    if (!entry) return null
    
    return {
      etag: entry.etag,
      lastModified: entry.lastModified,
    }
  }
  
  /**
   * Store a feed in cache
   */
  set(url: string, data: FeedResult, ttl?: number): void {
    const expiresAt = Date.now() + (ttl || config.rssCacheTTL)
    
    this.cache.set(url, {
      data,
      expiresAt,
      etag: data.etag,
      lastModified: data.lastModified,
    })
    
    this.updateAccessOrder(url)
    
    // Enforce max cache size
    if (this.cache.size > config.rssCacheMaxSize) {
      this.evictLRU()
    }
    
    logger.debug(`Cached feed: ${url}, expires at: ${new Date(expiresAt).toISOString()}`)
  }
  
  /**
   * Update existing cache entry with new data
   */
  update(url: string, data: FeedResult): void {
    const existing = this.cache.get(url)
    if (existing) {
      existing.data = data
      existing.etag = data.etag
      existing.lastModified = data.lastModified
      logger.debug(`Updated cached feed: ${url}`)
    }
  }
  
  /**
   * Check if a feed is cached (regardless of expiration)
   */
  has(url: string): boolean {
    return this.cache.has(url)
  }
  
  /**
   * Remove a feed from cache
   */
  delete(url: string): void {
    this.cache.delete(url)
    this.removeFromAccessOrder(url)
  }
  
  /**
   * Clear all cached feeds
   */
  clear(): void {
    this.cache.clear()
    this.accessOrder = []
    logger.info('Feed cache cleared')
  }
  
  /**
   * Get cache statistics
   */
  getStats(): { size: number; urls: string[] } {
    return {
      size: this.cache.size,
      urls: Array.from(this.cache.keys()),
    }
  }
  
  /**
   * Clean up expired entries
   */
  private cleanup(): void {
    const now = Date.now()
    let removed = 0
    
    for (const [url, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(url)
        this.removeFromAccessOrder(url)
        removed++
      }
    }
    
    if (removed > 0) {
      logger.debug(`Cleaned up ${removed} expired cache entries`)
    }
  }
  
  /**
   * Update LRU access order
   */
  private updateAccessOrder(url: string): void {
    this.removeFromAccessOrder(url)
    this.accessOrder.push(url)
  }
  
  /**
   * Remove from access order array
   */
  private removeFromAccessOrder(url: string): void {
    const index = this.accessOrder.indexOf(url)
    if (index > -1) {
      this.accessOrder.splice(index, 1)
    }
  }
  
  /**
   * Evict least recently used entry
   */
  private evictLRU(): void {
    if (this.accessOrder.length > 0) {
      const url = this.accessOrder[0]
      this.delete(url)
      logger.debug(`Evicted LRU cache entry: ${url}`)
    }
  }
  
  /**
   * Destroy cache and clear intervals
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
    }
    this.clear()
  }
}

// Singleton instance
export const feedCache = new FeedCache()
```

### 6. MCP Tools Implementation (index.ts excerpt)

```typescript
import { FastMCP, UserError } from '@missionsquad/fastmcp'
import { z } from 'zod'
import { rssReader } from './services/rss-reader.js'
import { feedCache } from './services/cache.js'
import { FeedResult, MultiFeedResult, FeedItem } from './types.js'
import { logger } from './logger.js'
import { config } from './config.js'

const server = new FastMCP({
  name: 'mcp-rss',
  version: '1.0.0',
})

// Tool 1: Fetch RSS Feed
const FetchRssFeedSchema = z.object({
  url: z.string().url().describe('The URL of the RSS feed to fetch'),
  useDescriptionAsContent: z.boolean().optional()
    .describe('If true, use description field as content instead of content field'),
})

server.addTool({
  name: 'fetch_rss_feed',
  description: 'Fetches and parses an RSS feed, returning structured data with feed info and items',
  parameters: FetchRssFeedSchema,
  execute: async (args, context) => {
    try {
      logger.info(`Fetching RSS feed: ${args.url}`)
      
      // Check cache first
      const cached = feedCache.get(args.url)
      if (cached) {
        logger.debug(`Returning cached feed: ${args.url}`)
        return JSON.stringify(cached, null, 2)
      }
      
      // Get cache metadata for conditional requests
      const cacheMeta = feedCache.getMetadata(args.url)
      
      // Fetch feed
      const result = await rssReader.fetchFeed(args.url, {
        useDescriptionAsContent: args.useDescriptionAsContent,
        etag: cacheMeta?.etag,
        lastModified: cacheMeta?.lastModified,
      })
      
      // Cache the result
      feedCache.set(args.url, result)
      
      logger.info(`Successfully fetched feed: ${args.url}, ${result.items.length} items`)
      return JSON.stringify(result, null, 2)
      
    } catch (error: any) {
      if (error.message === 'NOT_MODIFIED' && feedCache.has(args.url)) {
        // Return cached version if not modified
        const cached = feedCache.get(args.url)
        if (cached) {
          logger.debug(`Feed not modified, returning cache: ${args.url}`)
          return JSON.stringify(cached, null, 2)
        }
      }
      
      logger.error(`Failed to fetch RSS feed ${args.url}: ${error.message}`)
      throw new UserError(`Failed to fetch RSS feed: ${error.message}`)
    }
  },
})

// Tool 2: Fetch Multiple Feeds
const FetchMultipleFeedsSchema = z.object({
  urls: z.array(z.string().url()).describe('Array of RSS feed URLs to fetch'),
  parallel: z.boolean().optional().default(true)
    .describe('Whether to fetch feeds in parallel (true) or sequentially (false)'),
})

server.addTool({
  name: 'fetch_multiple_feeds',
  description: 'Batch fetch multiple RSS feeds with success/error status for each',
  parameters: FetchMultipleFeedsSchema,
  execute: async (args, context) => {
    logger.info(`Fetching ${args.urls.length} feeds (parallel: ${args.parallel})`)
    
    const fetchFeed = async (url: string): Promise<MultiFeedResult> => {
      try {
        // Check cache first
        const cached = feedCache.get(url)
        if (cached) {
          return { url, success: true, data: cached }
        }
        
        const result = await rssReader.fetchFeed(url)
        feedCache.set(url, result)
        
        return { url, success: true, data: result }
      } catch (error: any) {
        logger.error(`Failed to fetch ${url}: ${error.message}`)
        return {
          url,
          success: false,
          error: {
            url,
            error: error.message,
            code: error.code,
            timestamp: Date.now(),
          },
        }
      }
    }
    
    let results: MultiFeedResult[]
    
    if (args.parallel) {
      // Parallel fetching with concurrency limit
      const chunks: string[][] = []
      for (let i = 0; i < args.urls.length; i += config.rssMaxConcurrentFetches) {
        chunks.push(args.urls.slice(i, i + config.rssMaxConcurrentFetches))
      }
      
      results = []
      for (const chunk of chunks) {
        const chunkResults = await Promise.all(chunk.map(fetchFeed))
        results.push(...chunkResults)
      }
    } else {
      // Sequential fetching
      results = []
      for (const url of args.urls) {
        results.push(await fetchFeed(url))
      }
    }
    
    const successCount = results.filter(r => r.success).length
    logger.info(`Fetched ${successCount}/${args.urls.length} feeds successfully`)
    
    return JSON.stringify({
      total: args.urls.length,
      successful: successCount,
      failed: args.urls.length - successCount,
      results,
    }, null, 2)
  },
})

// Tool 3: Monitor Feed Updates
const MonitorFeedUpdatesSchema = z.object({
  url: z.string().url().describe('The RSS feed URL to monitor'),
  since: z.union([
    z.number().describe('Timestamp in milliseconds to check updates since'),
    z.literal('last').describe('Check updates since last fetch'),
  ]).describe('Time reference for checking updates'),
})

server.addTool({
  name: 'monitor_feed_updates',
  description: 'Check for new items in a feed since a specific time or last check',
  parameters: MonitorFeedUpdatesSchema,
  execute: async (args, context) => {
    logger.info(`Monitoring updates for: ${args.url} since ${args.since}`)
    
    // Get current feed state
    const currentFeed = await rssReader.fetchFeed(args.url)
    
    let sinceTimestamp: number
    
    if (args.since === 'last') {
      // Get last fetch time from cache
      const cached = feedCache.get(args.url)
      if (cached) {
        sinceTimestamp = cached.fetchedAt
      } else {
        // If no cache, return all items as new
        sinceTimestamp = 0
      }
    } else {
      sinceTimestamp = args.since
    }
    
    // Filter items newer than timestamp
    const newItems = currentFeed.items.filter(item => {
      const itemTime = item.published || item.updated || 0
      return itemTime > sinceTimestamp
    })
    
    // Update cache
    feedCache.set(args.url, currentFeed)
    
    logger.info(`Found ${newItems.length} new items since ${new Date(sinceTimestamp).toISOString()}`)
    
    return JSON.stringify({
      feedUrl: args.url,
      feedTitle: currentFeed.info.title,
      since: sinceTimestamp,
      sinceISO: new Date(sinceTimestamp).toISOString(),
      checkedAt: currentFeed.fetchedAt,
      checkedAtISO: new Date(currentFeed.fetchedAt).toISOString(),
      newItemsCount: newItems.length,
      totalItemsCount: currentFeed.items.length,
      newItems,
    }, null, 2)
  },
})

// Tool 4: Search Feed Items
const SearchFeedItemsSchema = z.object({
  feeds: z.array(z.string().url()).describe('RSS feed URLs to search across'),
  query: z.string().describe('Search query string'),
  searchIn: z.enum(['title', 'description', 'content', 'all']).optional().default('all')
    .describe('Which fields to search in'),
})

server.addTool({
  name: 'search_feed_items',
  description: 'Search for content across one or more RSS feeds',
  parameters: SearchFeedItemsSchema,
  execute: async (args, context) => {
    logger.info(`Searching ${args.feeds.length} feeds for: "${args.query}"`)
    
    const searchResults: Array<{
      feedUrl: string
      feedTitle: string | null
      item: FeedItem
      matches: string[]
    }> = []
    
    // Fetch all feeds
    for (const feedUrl of args.feeds) {
      try {
        let feed: FeedResult | null = feedCache.get(feedUrl)
        if (!feed) {
          feed = await rssReader.fetchFeed(feedUrl)
          feedCache.set(feedUrl, feed)
        }
        
        // Search items
        const queryLower = args.query.toLowerCase()
        for (const item of feed.items) {
          const matches: string[] = []
          
          // Search in specified fields
          if (args.searchIn === 'all' || args.searchIn === 'title') {
            if (item.title?.toLowerCase().includes(queryLower)) {
              matches.push('title')
            }
          }
          
          if (args.searchIn === 'all' || args.searchIn === 'description') {
            if (item.description?.toLowerCase().includes(queryLower)) {
              matches.push('description')
            }
          }
          
          if (args.searchIn === 'all' || args.searchIn === 'content') {
            if (item.content?.toLowerCase().includes(queryLower)) {
              matches.push('content')
            }
          }
          
          if (matches.length > 0) {
            searchResults.push({
              feedUrl,
              feedTitle: feed.info.title,
              item,
              matches,
            })
          }
        }
      } catch (error: any) {
        logger.error(`Failed to search feed ${feedUrl}: ${error.message}`)
      }
    }
    
    logger.info(`Found ${searchResults.length} matching items`)
    
    return JSON.stringify({
      query: args.query,
      searchIn: args.searchIn,
      feedsSearched: args.feeds.length,
      totalMatches: searchResults.length,
      results: searchResults,
    }, null, 2)
  },
})

// Tool 5: Extract Feed Content
const ExtractFeedContentSchema = z.object({
  url: z.string().url().describe('The RSS feed URL to extract content from'),
  format: z.enum(['markdown', 'text', 'html']).optional().default('text')
    .describe('Output format for the content'),
  includeMetadata: z.boolean().optional().default(false)
    .describe('Include item metadata (date, author, etc) in output'),
})

server.addTool({
  name: 'extract_feed_content',
  description: 'Extract and format feed content for different use cases',
  parameters: ExtractFeedContentSchema,
  execute: async (args, context) => {
    logger.info(`Extracting content from: ${args.url} (format: ${args.format})`)
    
    // Fetch feed
    let feed: FeedResult | null = feedCache.get(args.url)
    if (!feed) {
      feed = await rssReader.fetchFeed(args.url)
      feedCache.set(args.url, feed)
    }
    
    // Format content based on requested format
    const formatItem = (item: FeedItem): string => {
      const content = item.content || item.description || ''
      const metadata = args.includeMetadata ? [
        item.title ? `Title: ${item.title}` : '',
        item.author ? `Author: ${item.author}` : '',
        item.published ? `Published: ${new Date(item.published).toISOString()}` : '',
        item.url ? `URL: ${item.url}` : '',
        item.categories.length > 0 ? `Categories: ${item.categories.join(', ')}` : '',
      ].filter(Boolean).join('\n') : ''
      
      switch (args.format) {
        case 'markdown':
          const parts = []
          if (item.title) parts.push(`# ${item.title}`)
          if (metadata) parts.push(metadata)
          if (content) parts.push(content)
          if (item.url) parts.push(`\n[Read more](${item.url})`)
          return parts.join('\n\n')
          
        case 'html':
          const htmlParts = []
          if (item.title) htmlParts.push(`<h1>${item.title}</h1>`)
          if (metadata) htmlParts.push(`<div class="metadata">${metadata.replace(/\n/g, '<br>')}</div>`)
          if (content) htmlParts.push(`<div class="content">${content}</div>`)
          if (item.url) htmlParts.push(`<p><a href="${item.url}">Read more</a></p>`)
          return htmlParts.join('\n')
          
        case 'text':
        default:
          const textParts = []
          if (item.title) textParts.push(item.title)
          if (metadata) textParts.push(metadata)
          if (content) textParts.push(content)
          return textParts.join('\n\n')
      }
    }
    
    const formattedItems = feed.items.map(formatItem)
    
    const output = {
      feedTitle: feed.info.title,
      feedUrl: args.url,
      itemCount: feed.items.length,
      format: args.format,
      extractedAt: Date.now(),
      extractedAtISO: new Date().toISOString(),
      content: formattedItems,
    }
    
    logger.info(`Extracted content from ${feed.items.length} items`)
    return JSON.stringify(output, null, 2)
  },
})
```

### 7. MCP Resources Implementation (index.ts continuation)

```typescript
// Resource 1: Feed Cache Resource
server.addResourceTemplate({
  uriTemplate: 'rss://cache/{feedUrl}',
  name: 'RSS Feed Cache',
  description: 'Access cached feed data to avoid redundant fetches',
  mimeType: 'application/json',
  arguments: [
    {
      name: 'feedUrl',
      description: 'The URL of the RSS feed to retrieve from cache',
    },
  ],
  load: async (args) => {
    const cached = feedCache.get(args.feedUrl)
    if (!cached) {
      return {
        text: JSON.stringify({
          error: 'Feed not found in cache',
          feedUrl: args.feedUrl,
        }, null, 2),
      }
    }
    
    return {
      text: JSON.stringify({
        cached: true,
        feedUrl: args.feedUrl,
        cachedAt: cached.fetchedAt,
        data: cached,
      }, null, 2),
    }
  },
})

// Resource 2: OPML Export Resource
interface FeedSubscription {
  url: string
  title: string | null
  htmlUrl: string | null
}

const feedSubscriptions: FeedSubscription[] = [] // Track subscribed feeds

server.addResource({
  uri: 'rss://opml/export',
  name: 'OPML Export',
  description: 'Export all monitored feeds as OPML format',
  mimeType: 'text/xml',
  load: async () => {
    // Get all cached feeds for export
    const cacheStats = feedCache.getStats()
    const opmlFeeds: FeedSubscription[] = []
    
    for (const url of cacheStats.urls) {
      const cached = feedCache.get(url)
      if (cached) {
        opmlFeeds.push({
          url,
          title: cached.info.title,
          htmlUrl: cached.info.url,
        })
      }
    }
    
    // Generate OPML
    const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>MCP-RSS Feed Subscriptions</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
    <ownerName>MCP-RSS Server</ownerName>
  </head>
  <body>
    <outline text="RSS Feeds" title="RSS Feeds">
${opmlFeeds.map(feed => `      <outline type="rss" text="${escapeXml(feed.title || feed.url)}" title="${escapeXml(feed.title || feed.url)}" xmlUrl="${escapeXml(feed.url)}" htmlUrl="${escapeXml(feed.htmlUrl || '')}" />`).join('\n')}
    </outline>
  </body>
</opml>`
    
    return {
      text: opml,
    }
  },
})

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, ''')
}
```

### 8. Utility Functions

#### utils/content.ts
```typescript
import { JSDOM } from 'jsdom'
import DOMPurify from 'isomorphic-dompurify'

export interface CleanedContent {
  text: string
  html: string
}

/**
 * Extract and clean content from HTML
 */
export function extractCleanContent(html: string): CleanedContent {
  try {
    // Create DOM from HTML
    const dom = new JSDOM(html)
    const window = dom.window
    const purify = DOMPurify(window)
    
    // Sanitize HTML
    const cleanHtml = purify.sanitize(html, {
      ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'a', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
      ALLOWED_ATTR: ['href', 'title'],
    })
    
    // Extract text content
    const textContent = window.document.createElement('div')
    textContent.innerHTML = cleanHtml
    const text = textContent.textContent || ''
    
    return {
      text: text.trim().replace(/\s+/g, ' '),
      html: cleanHtml,
    }
  } catch (error) {
    // Fallback for non-HTML content
    return {
      text: html.replace(/<[^>]*>/g, '').trim().replace(/\s+/g, ' '),
      html: html,
    }
  }
}

/**
 * Sanitize string for use as ID
 */
export function sanitizeString(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
```

#### utils/date.ts
```typescript
/**
 * Convert various date formats to epoch milliseconds
 */
export function toEpochMs(date: Date | string | number | null | undefined): number | null {
  if (date === null || date === undefined) return null
  
  try {
    if (typeof date === 'number') return date
    const parsed = new Date(date)
    return isNaN(parsed.getTime()) ? null : parsed.getTime()
  } catch {
    return null
  }
}

/**
 * Format epoch milliseconds to ISO string
 */
export function epochToISO(epoch: number | null): string | null {
  if (epoch === null) return null
  try {
    return new Date(epoch).toISOString()
  } catch {
    return null
  }
}
```

#### utils/http.ts
```typescript
import axios, { AxiosInstance } from 'axios'
import { config } from '../config.js'

// Create axios instance with default config
export const httpClient: AxiosInstance = axios.create({
  timeout: config.rssRequestTimeout,
  maxRedirects: config.rssFollowRedirects ? 5 : 0,
  headers: {
    'User-Agent': config.rssUserAgent,
  },
  validateStatus: (status) => status < 500, // Don't throw on 4xx errors
})

// Add request interceptor for rate limiting
let requestQueue: Promise<any> = Promise.resolve()
let requestsThisMinute = 0
let minuteStart = Date.now()

httpClient.interceptors.request.use(async (requestConfig) => {
  // Rate limiting
  await requestQueue
  requestQueue = requestQueue.then(async () => {
    const now = Date.now()
    if (now - minuteStart > 60000) {
      requestsThisMinute = 0
      minuteStart = now
    }
    
    if (requestsThisMinute >= config.rssRateLimitPerMinute) {
      const waitTime = 60000 - (now - minuteStart)
      await new Promise(resolve => setTimeout(resolve, waitTime))
      requestsThisMinute = 0
      minuteStart = Date.now()
    }
    
    requestsThisMinute++
  })
  
  await requestQueue
  return requestConfig
})
```

### 9. Server Lifecycle and Error Handling (index.ts completion)

```typescript
// Error handling
process.on('SIGINT', () => {
  logger.info('Shutting down MCP-RSS server...')
  feedCache.destroy()
  process.exit(0)
})

process.on('SIGTERM', () => {
  logger.info('Shutting down MCP-RSS server...')
  feedCache.destroy()
  process.exit(0)
})

// Start server
server.start({
  transportType: 'stdio',
}).then(() => {
  logger.info('MCP-RSS server started successfully')
}).catch((error) => {
  logger.error('Failed to start MCP-RSS server:', error)
  process.exit(1)
})
```

### 10. Package.json

```json
{
  "name": "mcp-rss",
  "version": "1.0.0",
  "description": "MCP server for fetching, parsing, and managing RSS feeds",
  "main": "dist/index.js",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "clean": "rm -rf dist",
    "test": "jest"
  },
  "keywords": ["mcp", "rss", "feed", "atom", "xml"],
  "author": "Your Name",
  "license": "MIT",
  "dependencies": {
    "@missionsquad/fastmcp": "^1.0.0",
    "@rowanmanning/feed-parser": "^2.0.0",
    "axios": "^1.6.0",
    "dotenv": "^16.3.1",
    "isomorphic-dompurify": "^2.0.0",
    "jsdom": "^23.0.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "jest": "^29.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

### 11. Example Usage

#### Example 1: Fetch a single RSS feed
```json
{
  "tool": "fetch_rss_feed",
  "arguments": {
    "url": "https://example.com/feed.rss",
    "useDescriptionAsContent": false
  }
}

// Response:
{
  "info": {
    "title": "Example Blog",
    "description": "Latest posts from Example Blog",
    "url": "https://example.com",
    "feedUrl": "https://example.com/feed.rss",
    "language": "en-US",
    "copyright": null,
    "published": 1703001600000,
    "updated": 1703088000000,
    "categories": ["Technology", "Programming"],
    "author": "John Doe",
    "image": {
      "url": "https://example.com/logo.png",
      "title": "Example Blog Logo"
    }
  },
  "items": [
    {
      "id": "post-123",
      "title": "Understanding RSS Feeds",
      "url": "https://example.com/posts/understanding-rss",
      "content": "RSS (Really Simple Syndication) is a web feed format...",
      "description": "A comprehensive guide to RSS feeds",
      "published": 1703088000000,
      "updated": 1703088000000,
      "author": "Jane Smith",
      "categories": ["RSS", "Web Development"],
      "enclosures": [],
      "guid": "https://example.com/posts/understanding-rss"
    }
  ],
  "fetchedAt": 1703091600000,
  "etag": "W/\"123abc\"",
  "lastModified": "Thu, 21 Dec 2023 12:00:00 GMT"
}
```

#### Example 2: Monitor feed updates
```json
{
  "tool": "monitor_feed_updates",
  "arguments": {
    "url": "https://news.ycombinator.com/rss",
    "since": "last"
  }
}

// Response:
{
  "feedUrl": "https://news.ycombinator.com/rss",
  "feedTitle": "Hacker News",
  "since": 1703088000000,
  "sinceISO": "2023-12-20T12:00:00.000Z",
  "checkedAt": 1703091600000,
  "checkedAtISO": "2023-12-20T13:00:00.000Z",
  "newItemsCount": 5,
  "totalItemsCount": 30,
  "newItems": [
    {
      "id": "item-38745123",
      "title": "Show HN: My RSS Reader Project",
      "url": "https://news.ycombinator.com/item?id=38745123",
      "published": 1703090400000,
      "categories": []
    }
  ]
}
```

## Phase 2: Enhanced Features (Future Implementation)

### 1. Smart Caching Enhancement
- **HTTP Caching Headers**: Full support for ETag, Last-Modified, Cache-Control
- **Adaptive TTL**: Adjust cache duration based on feed update frequency
- **Persistent Cache**: SQLite-based cache for long-term storage
- **Cache Warming**: Pre-fetch feeds based on usage patterns

### 2. Content Enhancement
- **Readability Extraction**: Use `@mozilla/readability` to extract main article content
- **Summary Generation**: 
  - Basic extractive summarization using TF-IDF
  - Integration with LLM APIs for advanced summaries
- **Media Extraction**:
  - Parse and validate all media URLs
  - Extract podcast/video metadata
  - Generate thumbnail URLs
- **Language Detection**: Use `franc` library for content language detection

### 3. Feed Discovery
- **Auto-discovery Implementation**:
  ```typescript
  async discoverFeeds(url: string): Promise<string[]> {
    // 1. Check for direct feed URL
    // 2. Parse HTML for <link rel="alternate" type="application/rss+xml">
    // 3. Check common feed paths (/feed, /rss, /atom.xml)
    // 4. Look for feed icons and links in page content
  }
  ```
- **Feed Format Detection**: Support RSS 1.0/2.0, Atom, JSON Feed, Podcast feeds
- **OPML Import**: Parse OPML files to bulk import feed subscriptions

### 4. Advanced Filtering
```typescript
interface FilterOptions {
  dateRange?: { start: number; end: number }
  categories?: string[]
  minContentLength?: number
  maxContentLength?: number
  patterns?: {
    include?: RegExp[]
    exclude?: RegExp[]
  }
  authors?: string[]
  hasMedia?: boolean
}
```

### 5. Feed Validation & Quality
- **Feed Health Monitoring**:
  - Track feed reliability (uptime, response times)
  - Detect and report broken feeds
  - Monitor feed update frequency
- **Content Quality Metrics**:
  - Duplicate detection
  - Spam scoring
  - Content completeness check

### 6. Performance Optimizations
- **Streaming Parser**: Implement SAX-based parser for large feeds
- **Delta Updates**: Only fetch changed items using If-Modified-Since
- **Feed Prioritization**: Fetch high-priority feeds more frequently
- **WebSocket Support**: Real-time feed updates via WebSockets

### 7. Additional Tools
- **`analyze_feed_quality`**: Assess feed health and content quality
- **`discover_feeds`**: Auto-discover feeds from a website
- **`import_opml`**: Import feed subscriptions from OPML
- **`export_feeds`**: Export feeds in various formats (JSON, CSV, OPML)
- **`filter_feed_items`**: Advanced filtering with complex criteria
- **`generate_feed_summary`**: Create AI-powered feed summaries

### 8. Additional Resources
- **Feed Statistics**: `rss://stats/{feedUrl}` - Detailed feed analytics
- **Feed History**: `rss://history/{feedUrl}` - Historical feed data
- **Category Browser**: `rss://categories` - Browse feeds by category
- **Popular Items**: `rss://popular` - Most shared/viewed items

### 9. Integration Features
- **Webhook Support**: Send feed updates to webhooks
- **Database Export**: Export feeds to PostgreSQL/MongoDB
- **Search Integration**: Index feeds in Elasticsearch
- **Notification System**: Push notifications for important updates
