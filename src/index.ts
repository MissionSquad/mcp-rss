#!/usr/bin/env node

import { FastMCP, UserError } from "@missionsquad/fastmcp";
import { z } from "zod";
import { rssReader } from "./services/rss-reader.js";
import { feedCache } from "./services/cache.js";
import { FeedResult, MultiFeedResult, FeedItem } from "./types.js";
import { logger } from "./logger.js";
import { config } from "./config.js";

const server = new FastMCP({
  name: "mcp-rss",
  version: "1.0.0",
});

// Tool 1: Fetch RSS Feed
const FetchRssFeedSchema = z.object({
  url: z.string().describe("The URL of the RSS feed to fetch"),
  useDescriptionAsContent: z
    .string()
    .optional()
    .describe(
      "If 'true', use description field as content instead of content field"
    ),
});

server.addTool({
  name: "fetch_rss_feed",
  description:
    "Fetches and parses an RSS feed, returning structured data with feed info and items",
  parameters: FetchRssFeedSchema,
  execute: async (args, context) => {
    try {
      logger.info(`Fetching RSS feed: ${args.url}`);

      // Check cache first
      const cached = feedCache.get(args.url);
      if (cached) {
        logger.debug(`Returning cached feed: ${args.url}`);
        return JSON.stringify(cached, null, 2);
      }

      // Get cache metadata for conditional requests
      const cacheMeta = feedCache.getMetadata(args.url);

      // Fetch feed
      const result = await rssReader.fetchFeed(args.url, {
        useDescriptionAsContent: args.useDescriptionAsContent === 'true',
        etag: cacheMeta?.etag,
        lastModified: cacheMeta?.lastModified,
      });

      // Cache the result
      feedCache.set(args.url, result);

      logger.info(
        `Successfully fetched feed: ${args.url}, ${result.items.length} items`
      );
      return JSON.stringify(result, null, 2);
    } catch (error: any) {
      if (error.message === "NOT_MODIFIED" && feedCache.has(args.url)) {
        // Return cached version if not modified
        const cached = feedCache.get(args.url);
        if (cached) {
          logger.debug(`Feed not modified, returning cache: ${args.url}`);
          return JSON.stringify(cached, null, 2);
        }
      }

      logger.error(`Failed to fetch RSS feed ${args.url}: ${error.message}`);
      throw new UserError(`Failed to fetch RSS feed: ${error.message}`);
    }
  },
});

// Tool 2: Fetch Multiple Feeds
const FetchMultipleFeedsSchema = z.object({
  urls: z.array(z.string()).describe("Array of RSS feed URLs to fetch"),
  parallel: z
    .string()
    .optional()
    .default("true")
    .describe(
      "If 'true', fetch feeds in parallel; otherwise, fetch sequentially"
    ),
});

server.addTool({
  name: "fetch_multiple_feeds",
  description:
    "Batch fetch multiple RSS feeds with success/error status for each",
  parameters: FetchMultipleFeedsSchema,
  execute: async (args, context) => {
    logger.info(
      `Fetching ${args.urls.length} feeds (parallel: ${args.parallel})`
    );

    const fetchFeed = async (url: string): Promise<MultiFeedResult> => {
      try {
        // Check cache first
        const cached = feedCache.get(url);
        if (cached) {
          return { url, success: true, data: cached };
        }

        const result = await rssReader.fetchFeed(url);
        feedCache.set(url, result);

        return { url, success: true, data: result };
      } catch (error: any) {
        logger.error(`Failed to fetch ${url}: ${error.message}`);
        return {
          url,
          success: false,
          error: {
            url,
            error: error.message,
            code: error.code,
            timestamp: Date.now(),
          },
        };
      }
    };

    let results: MultiFeedResult[];

    if (args.parallel === 'true') {
      // Parallel fetching with concurrency limit
      const chunks: string[][] = [];
      for (
        let i = 0;
        i < args.urls.length;
        i += config.rssMaxConcurrentFetches
      ) {
        chunks.push(args.urls.slice(i, i + config.rssMaxConcurrentFetches));
      }

      results = [];
      for (const chunk of chunks) {
        const chunkResults = await Promise.all(chunk.map(fetchFeed));
        results.push(...chunkResults);
      }
    } else {
      // Sequential fetching
      results = [];
      for (const url of args.urls) {
        results.push(await fetchFeed(url));
      }
    }

    const successCount = results.filter((r) => r.success).length;
    logger.info(
      `Fetched ${successCount}/${args.urls.length} feeds successfully`
    );

    return JSON.stringify(
      {
        total: args.urls.length,
        successful: successCount,
        failed: args.urls.length - successCount,
        results,
      },
      null,
      2
    );
  },
});

// Tool 3: Monitor Feed Updates
const MonitorFeedUpdatesSchema = z.object({
  url: z.string().describe("The RSS feed URL to monitor"),
  since: z
    .union([
      z.number().describe("Timestamp in milliseconds to check updates since"),
      z.literal("last").describe("Check updates since last fetch"),
    ])
    .describe("Time reference for checking updates"),
});

server.addTool({
  name: "monitor_feed_updates",
  description:
    "Check for new items in a feed since a specific time or last check",
  parameters: MonitorFeedUpdatesSchema,
  execute: async (args, context) => {
    logger.info(`Monitoring updates for: ${args.url} since ${args.since}`);

    // Get current feed state
    const currentFeed = await rssReader.fetchFeed(args.url);

    let sinceTimestamp: number;

    if (args.since === "last") {
      // Get last fetch time from cache
      const cached = feedCache.get(args.url);
      if (cached) {
        sinceTimestamp = cached.fetchedAt;
      } else {
        // If no cache, return all items as new
        sinceTimestamp = 0;
      }
    } else {
      sinceTimestamp = args.since;
    }

    // Filter items newer than timestamp
    const newItems = currentFeed.items.filter((item) => {
      const itemTime = item.published || item.updated || 0;
      return itemTime > sinceTimestamp;
    });

    // Update cache
    feedCache.set(args.url, currentFeed);

    logger.info(
      `Found ${newItems.length} new items since ${new Date(
        sinceTimestamp
      ).toISOString()}`
    );

    return JSON.stringify(
      {
        feedUrl: args.url,
        feedTitle: currentFeed.info.title,
        since: sinceTimestamp,
        sinceISO: new Date(sinceTimestamp).toISOString(),
        checkedAt: currentFeed.fetchedAt,
        checkedAtISO: new Date(currentFeed.fetchedAt).toISOString(),
        newItemsCount: newItems.length,
        totalItemsCount: currentFeed.items.length,
        newItems,
      },
      null,
      2
    );
  },
});

// Tool 4: Search Feed Items
const SearchFeedItemsSchema = z.object({
  feeds: z.array(z.string()).describe("RSS feed URLs to search across"),
  query: z.string().describe("Search query string"),
  searchIn: z
    .enum(["title", "description", "content", "all"])
    .optional()
    .default("all")
    .describe("Which fields to search in"),
});

server.addTool({
  name: "search_feed_items",
  description: "Search for content across one or more RSS feeds",
  parameters: SearchFeedItemsSchema,
  execute: async (args, context) => {
    logger.info(`Searching ${args.feeds.length} feeds for: "${args.query}"`);

    const searchResults: Array<{
      feedUrl: string;
      feedTitle: string | null;
      item: FeedItem;
      matches: string[];
    }> = [];

    // Fetch all feeds
    for (const feedUrl of args.feeds) {
      try {
        let feed: FeedResult | null = feedCache.get(feedUrl);
        if (!feed) {
          feed = await rssReader.fetchFeed(feedUrl);
          feedCache.set(feedUrl, feed);
        }

        // Search items
        const queryLower = args.query.toLowerCase();
        for (const item of feed.items) {
          const matches: string[] = [];

          // Search in specified fields
          if (args.searchIn === "all" || args.searchIn === "title") {
            if (item.title?.toLowerCase().includes(queryLower)) {
              matches.push("title");
            }
          }

          if (args.searchIn === "all" || args.searchIn === "description") {
            if (item.description?.toLowerCase().includes(queryLower)) {
              matches.push("description");
            }
          }

          if (args.searchIn === "all" || args.searchIn === "content") {
            if (item.content?.toLowerCase().includes(queryLower)) {
              matches.push("content");
            }
          }

          if (matches.length > 0) {
            searchResults.push({
              feedUrl,
              feedTitle: feed.info.title,
              item,
              matches,
            });
          }
        }
      } catch (error: any) {
        logger.error(`Failed to search feed ${feedUrl}: ${error.message}`);
      }
    }

    logger.info(`Found ${searchResults.length} matching items`);

    return JSON.stringify(
      {
        query: args.query,
        searchIn: args.searchIn,
        feedsSearched: args.feeds.length,
        totalMatches: searchResults.length,
        results: searchResults,
      },
      null,
      2
    );
  },
});

// Tool 5: Extract Feed Content
const ExtractFeedContentSchema = z.object({
  url: z.string().describe("The RSS feed URL to extract content from"),
  format: z
    .enum(["markdown", "text", "html", "json"])
    .optional()
    .default("text")
    .describe("Output format for the content"),
  includeMetadata: z
    .string()
    .optional()
    .default("false")
    .describe("If 'true', include item metadata (date, author, etc) in output"),
});

server.addTool({
  name: "extract_feed_content",
  description: "Extract and format feed content for different use cases",
  parameters: ExtractFeedContentSchema,
  execute: async (args, context) => {
    logger.info(
      `Extracting content from: ${args.url} (format: ${args.format})`
    );

    // Fetch feed
    let feed: FeedResult | null = feedCache.get(args.url);
    if (!feed) {
      feed = await rssReader.fetchFeed(args.url);
      feedCache.set(args.url, feed);
    }

    // Format content based on requested format
    const formatItem = (item: FeedItem): string | object => {
      const content = item.content || item.description || "";
      const metadata = {
        title: item.title,
        author: item.author,
        published: item.published
          ? new Date(item.published).toISOString()
          : null,
        url: item.url,
        categories: item.categories,
      };

      if (args.format === "json") {
        return args.includeMetadata === 'true' ? { ...metadata, content } : { content };
      }

      const metadataText = args.includeMetadata === 'true'
        ? [
            item.title ? `Title: ${item.title}` : "",
            item.author ? `Author: ${item.author}` : "",
            item.published
              ? `Published: ${new Date(item.published).toISOString()}`
              : "",
            item.url ? `URL: ${item.url}` : "",
            item.categories.length > 0
              ? `Categories: ${item.categories.join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n")
        : "";

      switch (args.format) {
        case "markdown":
          const parts = [];
          if (item.title) parts.push(`# ${item.title}`);
          if (metadataText) parts.push(metadataText);
          if (content) parts.push(content);
          if (item.url) parts.push(`\n[Read more](${item.url})`);
          return parts.join("\n\n");

        case "html":
          const htmlParts = [];
          if (item.title) htmlParts.push(`<h1>${item.title}</h1>`);
          if (metadataText)
            htmlParts.push(
              `<div class="metadata">${metadataText.replace(
                /\n/g,
                "<br>"
              )}</div>`
            );
          if (content) htmlParts.push(`<div class="content">${content}</div>`);
          if (item.url)
            htmlParts.push(`<p><a href="${item.url}">Read more</a></p>`);
          return htmlParts.join("\n");

        case "text":
        default:
          const textParts = [];
          if (item.title) textParts.push(item.title);
          if (metadataText) textParts.push(metadataText);
          if (content) textParts.push(content);
          return textParts.join("\n\n");
      }
    };

    const formattedItems = feed.items.map(formatItem);

    const output = {
      feedTitle: feed.info.title,
      feedUrl: args.url,
      itemCount: feed.items.length,
      format: args.format,
      extractedAt: Date.now(),
      extractedAtISO: new Date().toISOString(),
      content: formattedItems,
    };

    logger.info(`Extracted content from ${feed.items.length} items`);
    return JSON.stringify(output, null, 2);
  },
});

// Tool 6: Get Feed Headlines
const GetFeedHeadlinesSchema = z.object({
  url: z.string().describe("The RSS feed URL to get headlines from"),
  format: z
    .enum(["markdown", "text", "html", "json"])
    .optional()
    .default("json")
    .describe("Output format for the headlines"),
});

server.addTool({
  name: "get_feed_headlines",
  description:
    "Gets a list of headlines from a feed, including title, summary, and URL.",
  parameters: GetFeedHeadlinesSchema,
  execute: async (args, context) => {
    logger.info(`Getting headlines from: ${args.url}`);

    // Fetch feed
    let feed: FeedResult | null = feedCache.get(args.url);
    if (!feed) {
      feed = await rssReader.fetchFeed(args.url);
      feedCache.set(args.url, feed);
    }

    // Format headlines
    const formatHeadline = (item: FeedItem) => {
      const headline = {
        title: item.title,
        summary: item.description || item.content,
        url: item.url,
        published: item.published,
        author: item.author,
      };

      switch (args.format) {
        case "markdown":
          return `### [${headline.title}](${headline.url})\n${headline.summary}`;
        case "html":
          return `<h3><a href="${headline.url}">${headline.title}</a></h3><p>${headline.summary}</p>`;
        case "text":
          return `${headline.title}\n${headline.summary}\n${headline.url}`;
        case "json":
        default:
          return headline;
      }
    };

    const headlines = feed.items.map(formatHeadline);

    const output = {
      feedTitle: feed.info.title,
      feedUrl: args.url,
      itemCount: feed.items.length,
      format: args.format,
      headlines,
    };

    logger.info(`Got ${headlines.length} headlines from ${args.url}`);
    return JSON.stringify(output, null, 2);
  },
});

// Resource 1: Feed Cache Resource
server.addResourceTemplate({
  uriTemplate: "rss://cache/{feedUrl}",
  name: "RSS Feed Cache",
  description: "Access cached feed data to avoid redundant fetches",
  mimeType: "application/json",
  arguments: [
    {
      name: "feedUrl",
      description: "The URL of the RSS feed to retrieve from cache",
    },
  ],
  load: async (args) => {
    const cached = feedCache.get(args.feedUrl);
    if (!cached) {
      return {
        text: JSON.stringify(
          {
            error: "Feed not found in cache",
            feedUrl: args.feedUrl,
          },
          null,
          2
        ),
      };
    }

    return {
      text: JSON.stringify(
        {
          cached: true,
          feedUrl: args.feedUrl,
          cachedAt: cached.fetchedAt,
          data: cached,
        },
        null,
        2
      ),
    };
  },
});

// Resource 2: OPML Export Resource
interface FeedSubscription {
  url: string;
  title: string | null;
  htmlUrl: string | null;
}

server.addResource({
  uri: "rss://opml/export",
  name: "OPML Export",
  description: "Export all monitored feeds as OPML format",
  mimeType: "text/xml",
  load: async () => {
    // Get all cached feeds for export
    const cacheStats = feedCache.getStats();
    const opmlFeeds: FeedSubscription[] = [];

    for (const url of cacheStats.urls) {
      const cached = feedCache.get(url);
      if (cached) {
        opmlFeeds.push({
          url,
          title: cached.info.title,
          htmlUrl: cached.info.url,
        });
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
${opmlFeeds
  .map(
    (feed) =>
      `      <outline type="rss" text="${escapeXml(
        feed.title || feed.url
      )}" title="${escapeXml(feed.title || feed.url)}" xmlUrl="${escapeXml(
        feed.url
      )}" htmlUrl="${escapeXml(feed.htmlUrl || "")}" />`
  )
  .join("\n")}
    </outline>
  </body>
</opml>`;

    return {
      text: opml,
    };
  },
});

function escapeXml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/'/g, "'");
}

// Error handling
process.on("SIGINT", () => {
  logger.info("Shutting down MCP-RSS server...");
  feedCache.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("Shutting down MCP-RSS server...");
  feedCache.destroy();
  process.exit(0);
});

// Start server
server
  .start({
    transportType: "stdio",
  })
  .then(() => {
    logger.info("MCP-RSS server started successfully");
  })
  .catch((error) => {
    logger.error("Failed to start MCP-RSS server:", error);
    process.exit(1);
  });
