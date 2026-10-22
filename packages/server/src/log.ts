export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const threshold = ORDER[level];
  const write = (severity: LogLevel, message: string, args: unknown[]) => {
    if (ORDER[severity] < threshold) return;
    const line = `${new Date().toISOString()} ${severity.toUpperCase()} ${message}`;
    const fn = severity === 'error' ? console.error : severity === 'warn' ? console.warn : console.log;
    fn(line, ...args);
  };
  return {
    debug: (message, ...args) => write('debug', message, args),
    info: (message, ...args) => write('info', message, args),
    warn: (message, ...args) => write('warn', message, args),
    error: (message, ...args) => write('error', message, args)
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};
