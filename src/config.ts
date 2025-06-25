import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const ConfigSchema = z.object({
  // Cache settings
  rssCacheTTL: z.coerce.number().min(0).default(900000), // 15 minutes in ms
  rssMaxItemsPerFeed: z.coerce.number().min(1).default(100),
  
  // HTTP settings
  rssRequestTimeout: z.coerce.number().min(1000).default(30000), // 30 seconds
  rssMaxConcurrentFetches: z.coerce.number().min(1).default(5),
  rssUserAgent: z.string().default('MCP-RSS/1.0.0'),
  rssFollowRedirects: z.preprocess((val) => String(val).toLowerCase() === 'true', z.boolean()).default(true),
  rssMaxResponseSize: z.coerce.number().default(20 * 1024 * 1024), // 20MB
  
  // Storage settings
  rssStoragePath: z.string().optional(),
  rssEnablePersistence: z.preprocess((val) => String(val).toLowerCase() === 'true', z.boolean()).default(false),
  
  // Cache management
  rssCacheMaxSize: z.coerce.number().default(100), // Max number of feeds in cache
  rssCacheCleanupInterval: z.coerce.number().default(300000), // 5 minutes
  
  // Rate limiting
  rssRateLimitPerMinute: z.coerce.number().default(60),
  
  // Logging
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export const config = ConfigSchema.parse({
  rssCacheTTL: process.env.RSS_CACHE_TTL,
  rssMaxItemsPerFeed: process.env.RSS_MAX_ITEMS_PER_FEED,
  rssRequestTimeout: process.env.RSS_REQUEST_TIMEOUT,
  rssMaxConcurrentFetches: process.env.RSS_MAX_CONCURRENT_FETCHES,
  rssUserAgent: process.env.RSS_USER_AGENT,
  rssFollowRedirects: process.env.RSS_FOLLOW_REDIRECTS,
  rssMaxResponseSize: process.env.RSS_MAX_RESPONSE_SIZE,
  rssStoragePath: process.env.RSS_STORAGE_PATH,
  rssEnablePersistence: process.env.RSS_ENABLE_PERSISTENCE,
  rssCacheMaxSize: process.env.RSS_CACHE_MAX_SIZE,
  rssCacheCleanupInterval: process.env.RSS_CACHE_CLEANUP_INTERVAL,
  rssRateLimitPerMinute: process.env.RSS_RATE_LIMIT_PER_MINUTE,
  logLevel: process.env.LOG_LEVEL,
});

export type Config = z.infer<typeof ConfigSchema>;
