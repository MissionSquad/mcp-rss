// Core RSS Feed Types
export interface FeedItem {
  id: string;
  title: string | null;
  url: string | null;
  content: string | null;
  description: string | null;
  published: number | null;  // epoch milliseconds
  updated: number | null;    // epoch milliseconds
  author: string | null;
  categories: string[];
  enclosures: Enclosure[];
  guid: string | null;
}

export interface Enclosure {
  url: string;
  type: string | null;
  length: number | null;
}

export interface FeedInfo {
  title: string | null;
  description: string | null;
  url: string | null;
  feedUrl: string;
  language: string | null;
  copyright: string | null;
  published: number | null;  // epoch milliseconds
  updated: number | null;    // epoch milliseconds
  categories: string[];
  author: string | null;
  image: {
    url: string | null;
    title: string | null;
  } | null;
}

export interface FeedResult {
  info: FeedInfo;
  items: FeedItem[];
  fetchedAt: number;  // epoch milliseconds
  etag?: string;
  lastModified?: string;
}

export interface FeedError {
  url: string;
  error: string;
  code?: string;
  timestamp: number;
}

export interface MultiFeedResult {
  url: string;
  success: boolean;
  data?: FeedResult;
  error?: FeedError;
}

export interface CacheEntry {
  data: FeedResult;
  expiresAt: number;
  etag?: string;
  lastModified?: string;
}

export interface FeedMetadata {
  url: string;
  title: string | null;
  lastFetchedAt: number;
  itemCount: number;
  settings: {
    useDescriptionAsContent?: boolean;
    cacheTTL?: number;  // Override default TTL in milliseconds
  };
}

// Tool Parameter Types
export interface FetchRssFeedParams {
  url: string;
  useDescriptionAsContent?: boolean;
}

export interface FetchMultipleFeedsParams {
  urls: string[];
  parallel?: boolean;
}

export interface MonitorFeedUpdatesParams {
  url: string;
  since: number | 'last';
}

export interface SearchFeedItemsParams {
  feeds: string[];
  query: string;
  searchIn?: 'title' | 'description' | 'content' | 'all';
}

export interface ExtractFeedContentParams {
  url: string;
  format?: 'markdown' | 'text' | 'html' | 'json';
  includeMetadata?: boolean;
}

export interface FeedHeadline {
  title: string | null;
  summary: string | null;
  url: string | null;
  published: number | null;
  author: string | null;
}
