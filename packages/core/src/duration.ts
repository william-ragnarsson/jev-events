/** Milliseconds, or a string such as "500ms", "30s", "5m", "2h" or "1d". */
export type Duration = number | `${number}${"ms" | "s" | "m" | "h" | "d"}`;

const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function toMs(duration: Duration): number {
  if (typeof duration === "number") return duration;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(duration.trim());
  if (!match) throw new TypeError(`Invalid duration "${duration}". Use e.g. "500ms", "30s", "5m".`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}
