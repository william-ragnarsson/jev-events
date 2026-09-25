export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/** A console logger prefixed with `[jev-events]` that drops messages below `level`. */
export function createLogger(level: LogLevel = "info", sink: Logger = console): Logger {
  const at = ORDER[level];
  const write =
    (name: Exclude<LogLevel, "silent">) =>
    (message: string, ...args: unknown[]) => {
      if (ORDER[name] >= at) sink[name](`[jev-events] ${message}`, ...args);
    };
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}

export const silentLogger: Logger = createLogger("silent");
