# MCP-RSS Server

A Model Context Protocol (MCP) server for fetching, parsing, and managing RSS feeds.

## Features

*   Fetch and parse RSS/Atom feeds
*   In-memory caching with TTL
*   Batch fetching of multiple feeds
*   Monitor feeds for new items
*   Search content across multiple feeds
*   Extract and format feed content
*   OPML export of subscribed feeds

## Getting Started

### Prerequisites

*   Node.js v20 or later
*   npm or yarn

### Setup

1.  **Install Dependencies:**
    ```bash
    yarn
    ```
2.  **Configure Environment:**
    *   Copy `.env.example` to `.env`.
    *   Edit `.env` and set the necessary environment variables.
3.  **Build the Project:**
    ```bash
    yarn build
    ```
4.  **Start the Server:**
    ```bash
    yarn start
    ```

## Available Tools

*   `fetch_rss_feed`: Fetches and parses a single RSS feed.
*   `fetch_multiple_feeds`: Fetches multiple RSS feeds in parallel or sequentially.
*   `monitor_feed_updates`: Checks for new items in a feed since a specific time.
*   `search_feed_items`: Searches for content across one or more RSS feeds.
*   `extract_feed_content`: Extracts and formats content from feed items. Supports `json`, `markdown`, `html`, and `text` formats.
*   `get_feed_headlines`: Gets a list of headlines from a feed. Supports `json`, `markdown`, `html`, and `text` formats.

## Available Resources

*   `rss://cache/{feedUrl}`: Access cached feed data.
*   `rss://opml/export`: Export all monitored feeds in OPML format.

## Configuration

Configure the server using environment variables defined in `.env`. See `.env.example` for all available options.

---

## Try it on Mission Squad

You can test the `mcp-rss` server and other MCP servers on the [Mission Squad](https://missionsquad.ai) platform. Mission Squad is an Agentic AI Platform that allows you to build, manage, and deploy cooperative agents that connect to any model, leverage private data, and automate complex tasks. Sign up for a free account to get started.
