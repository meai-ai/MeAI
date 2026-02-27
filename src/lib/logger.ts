/**
 * Minimal structured logger — replaces silent catch blocks.
 * No dependencies. Formats as [module] level: message.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Default minimum level — can be overridden via LOG_LEVEL env var
const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export function createLogger(module: string): Logger {
  function log(level: LogLevel, msg: string, args: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

    const prefix = `[${module}]`;
    const fn = level === "error" ? console.error
      : level === "warn" ? console.warn
      : console.log;

    if (args.length === 0) {
      fn(`${prefix} ${level}: ${msg}`);
    } else {
      fn(`${prefix} ${level}: ${msg}`, ...args);
    }
  }

  return {
    debug: (msg, ...args) => log("debug", msg, args),
    info: (msg, ...args) => log("info", msg, args),
    warn: (msg, ...args) => log("warn", msg, args),
    error: (msg, ...args) => log("error", msg, args),
  };
}
