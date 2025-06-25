import { config } from './config.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levels: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel = levels[config.logLevel];

function log(level: LogLevel, message: string, ...args: any[]) {
  if (levels[level] >= currentLevel) {
    const timestamp = new Date().toISOString();
    // Direct all logging to stderr to avoid interfering with stdout communication
    console.error(`[${timestamp}] [${level.toUpperCase()}] ${message}`, ...args);
  }
}

export const logger = {
  debug: (message: string, ...args: any[]) => log('debug', message, ...args),
  info: (message: string, ...args: any[]) => log('info', message, ...args),
  warn: (message: string, ...args: any[]) => log('warn', message, ...args),
  error: (message: string, ...args: any[]) => log('error', message, ...args),
};
