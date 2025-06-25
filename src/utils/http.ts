import axios, { AxiosInstance } from 'axios';
import { config } from '../config.js';

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
