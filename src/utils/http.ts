import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { config } from '../config.js';

/**
 * Resolves a single response header to a trimmed string, or null if absent.
 */
function headerValue(headers: AxiosResponse['headers'], name: string): string | null {
  const raw = (headers as Record<string, unknown>)[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null) {
    return null;
  }
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

/**
 * Derives how long to wait before retrying a rate-limited (HTTP 429) request,
 * based on standard rate-limit response headers.
 *
 * Precedence: `Retry-After` (delta-seconds or HTTP-date), then `X-RateLimit-Reset`
 * (delta-seconds, or epoch seconds when the value is implausibly large as a delta).
 * Falls back to a linear backoff when neither header is present. A small buffer is
 * added so the retry lands past the window boundary.
 */
export function getRetryDelayMs(headers: AxiosResponse['headers'], attempt: number): number {
  const bufferMs = 1000;

  const retryAfter = headerValue(headers, 'retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000) + bufferMs;
    }
    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) {
      return Math.max(0, dateMs - Date.now()) + bufferMs;
    }
  }

  const reset = headerValue(headers, 'x-ratelimit-reset');
  if (reset !== null) {
    const value = Number(reset);
    if (Number.isFinite(value)) {
      const deltaMs = value > 1_000_000_000 ? value * 1000 - Date.now() : value * 1000;
      return Math.max(0, deltaMs) + bufferMs;
    }
  }

  return attempt * 5000;
}

/**
 * Async, non-blocking delay.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Create axios instance with default config
export const httpClient: AxiosInstance = axios.create({
  timeout: config.rssRequestTimeout,
  maxRedirects: config.rssFollowRedirects ? 5 : 0,
  headers: {
    'User-Agent': config.rssUserAgent,
  },
  validateStatus: (status) => status < 500, // Don't throw on 4xx errors
});

// Add request interceptor for rate limiting
let requestQueue: Promise<any> = Promise.resolve();
let requestsThisMinute = 0;
let minuteStart = Date.now();

httpClient.interceptors.request.use(async (requestConfig) => {
  // Rate limiting
  await requestQueue;
  requestQueue = requestQueue.then(async () => {
    const now = Date.now();
    if (now - minuteStart > 60000) {
      requestsThisMinute = 0;
      minuteStart = now;
    }
    
    if (requestsThisMinute >= config.rssRateLimitPerMinute) {
      const waitTime = 60000 - (now - minuteStart);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      requestsThisMinute = 0;
      minuteStart = Date.now();
    }
    
    requestsThisMinute++;
  });
  
  await requestQueue;
  return requestConfig;
});
