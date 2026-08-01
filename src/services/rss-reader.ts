import { parseFeed } from '@rowanmanning/feed-parser';
import { Feed } from '@rowanmanning/feed-parser/lib/feed/base.js';
import { FeedItem as RSSFeedItem } from '@rowanmanning/feed-parser/lib/feed/item/base.js';
import { FeedResult, FeedInfo, FeedItem, Enclosure } from '../types.js';
import { httpClient, getRetryDelayMs, sleep } from '../utils/http.js';
import { toEpochMs } from '../utils/date.js';
import { extractCleanContent, sanitizeString } from '../utils/content.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { nanoid } from 'nanoid';

// Padding added to server-requested retry delays so the retry lands past the
// rate-limit window boundary; excluded from the rssRateLimitMaxDelay cap check.
const RATE_LIMIT_RETRY_BUFFER_MS = 1000;

export class RSSReader {
  /**
   * Fetches raw RSS feed data from a URL
   */
  async fetchRawFeed(url: string, etag?: string, lastModified?: string): Promise<{
    data: string;
    etag?: string;
    lastModified?: string;
    notModified: boolean;
    contentType?: string;
  }> {
    logger.debug(`Fetching RSS feed from: ${url}`);

    const headers: Record<string, string> = {
      'User-Agent': config.rssUserAgent,
      'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    };

    if (etag) {
      headers['If-None-Match'] = etag;
    }
    if (lastModified) {
      headers['If-Modified-Since'] = lastModified;
    }

    const maxAttempts = config.rssRateLimitMaxRetries + 1;

    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await httpClient.get(url, {
          headers,
          timeout: config.rssRequestTimeout,
          maxRedirects: config.rssFollowRedirects ? 5 : 0,
          responseType: 'text',
          maxContentLength: config.rssMaxResponseSize,
        });
      } catch (error: any) {
        logger.error(`Error fetching RSS feed from ${url}: ${error.message}`);
        throw new Error(`HTTP request failed: ${error.message}`);
      }

      if (response.status === 304) {
        logger.debug(`Feed not modified: ${url}`);
        return { data: '', notModified: true, etag: response.headers.etag, lastModified: response.headers['last-modified'] };
      }

      // Feed hosts (e.g. reddit.com) rate limit aggressively; honor their
      // advertised reset delay instead of surfacing a garbage body downstream.
      if (response.status === 429) {
        const delayMs = getRetryDelayMs(response.headers, attempt);
        if (attempt < maxAttempts && delayMs <= config.rssRateLimitMaxDelay) {
          const sleepMs = delayMs + RATE_LIMIT_RETRY_BUFFER_MS;
          logger.warn(
            `Rate limited (HTTP 429) fetching ${url}; retrying in ${Math.ceil(sleepMs / 1000)}s (attempt ${attempt}/${maxAttempts})`
          );
          await sleep(sleepMs);
          continue;
        }
        logger.error(`Rate limited (HTTP 429) fetching ${url}; giving up after ${attempt} attempt(s)`);
        throw new Error(
          `HTTP 429 Too Many Requests — the feed host is rate limiting requests; retry in ~${Math.ceil(delayMs / 1000)}s`
        );
      }

      if (response.status >= 400) {
        logger.error(`HTTP ${response.status} fetching RSS feed from ${url}`);
        throw new Error(
          `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''} — the feed host rejected the request`
        );
      }

      if (response.status >= 300) {
        const location = response.headers.location;
        logger.error(`HTTP ${response.status} redirect not followed for ${url}`);
        throw new Error(
          `HTTP ${response.status} redirect${location ? ` to ${location}` : ''} was not followed (RSS_FOLLOW_REDIRECTS is disabled)`
        );
      }

      const body = typeof response.data === 'string' ? response.data : '';
      if (!body.trim()) {
        logger.error(`Empty response body (HTTP ${response.status}) from ${url}`);
        throw new Error(`Received an empty response body (HTTP ${response.status})`);
      }

      return {
        data: body,
        etag: response.headers.etag,
        lastModified: response.headers['last-modified'],
        notModified: false,
        contentType: response.headers['content-type'],
      };
    }
  }
  
  /**
   * Parses RSS feed XML into structured data
   */
  async parseFeed(xml: string): Promise<Feed | null> {
    try {
      return parseFeed(xml);
    } catch (error: any) {
      logger.error(`Error parsing RSS feed: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Formats parsed feed into our internal structure
   */
  formatFeed(feed: Feed, feedUrl: string, useDescriptionAsContent?: boolean): FeedResult {
    const feedJson = feed.toJSON();
    const { items: _, ...feedMeta } = feedJson;
    
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
      author: feedMeta.authors?.[0]?.name || null,
      image: feedMeta.image ? {
        url: feedMeta.image.url || null,
        title: feedMeta.image.title || null,
      } : null,
    };
    
    // Format items
    const items: FeedItem[] = feed.items
      .slice(0, config.rssMaxItemsPerFeed)
      .map((item: RSSFeedItem) => {
        const itemJson = item.toJSON();
        
        // Clean content and description
        let content = itemJson.content || null;
        let description = itemJson.description || null;
        
        if (content) {
          content = extractCleanContent(content).text;
        }
        if (description) {
          description = extractCleanContent(description).text;
        }
        
        // Handle useDescriptionAsContent option
        if (useDescriptionAsContent && description) {
          content = description;
        }
        
        // Safely access properties that may not be on the base type
        const guid = 'guid' in item ? String(item.guid) : nanoid();
        const enclosures: Enclosure[] = ('enclosures' in item && Array.isArray(item.enclosures))
          ? item.enclosures.map((enc: { url: string; type?: string; length?: string }) => ({
              url: enc.url,
              type: enc.type || null,
              length: enc.length ? parseInt(enc.length, 10) : null,
            }))
          : [];

        return {
          id: sanitizeString(guid || itemJson.url || itemJson.title || ''),
          title: itemJson.title || null,
          url: itemJson.url || null,
          content,
          description,
          published: toEpochMs(itemJson.published),
          updated: toEpochMs(itemJson.updated),
          author: itemJson.authors?.[0]?.name || null,
          categories: itemJson.categories?.map((c: any) => c.label || c) || [],
          enclosures,
          guid: guid,
        };
      });
    
    return {
      info,
      items,
      fetchedAt: Date.now(),
    };
  }
  
  /**
   * Complete feed fetching and parsing pipeline
   */
  async fetchFeed(
    url: string,
    options?: {
      useDescriptionAsContent?: boolean;
      etag?: string;
      lastModified?: string;
    }
  ): Promise<FeedResult> {
    // Fetch raw feed
    const { data, etag, lastModified, notModified, contentType } = await this.fetchRawFeed(
      url,
      options?.etag,
      options?.lastModified
    );

    if (notModified) {
      throw new Error('NOT_MODIFIED');
    }

    // Parse feed
    const parsed = await this.parseFeed(data);
    if (!parsed) {
      throw new Error(
        `Failed to parse feed XML — the response does not appear to be a valid RSS/Atom feed${contentType ? ` (content-type: ${contentType})` : ''}`
      );
    }
    
    // Format feed
    const result = this.formatFeed(parsed, url, options?.useDescriptionAsContent);
    
    // Add cache headers if available
    if (etag) result.etag = etag;
    if (lastModified) result.lastModified = lastModified;
    
    return result;
  }
}

// Singleton instance
export const rssReader = new RSSReader();
