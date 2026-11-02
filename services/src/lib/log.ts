import { installConsoleRedaction, redact } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, ...rest: unknown[]): void;
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
}

/** Logs go through console, which installConsoleRedaction() wraps; messages are redacted here too. */
export function createLogger(scope: string, level: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info"): Logger {
  installConsoleRedaction();
  const min = ORDER[level] ?? ORDER.info;
  const at = () => new Date().toISOString();
  const emit = (lvl: LogLevel, fn: (...a: unknown[]) => void) => (m: string, ...r: unknown[]) => {
    if (ORDER[lvl] >= min) fn(`${at()} [${scope}] ${lvl === "info" || lvl === "debug" ? "" : `${lvl.toUpperCase()} `}${redact(m)}`, ...r);
  };
  return {
    debug: emit("debug", console.debug),
    info: emit("info", console.log),
    warn: emit("warn", console.warn),
    error: emit("error", console.error),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
