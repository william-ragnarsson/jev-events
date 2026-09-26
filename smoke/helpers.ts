/** Poll until `condition` holds, or fail saying what never arrived. */
export async function waitFor(condition: () => boolean, ms: number, what: string): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error(`Waited ${Math.round(ms / 1000)}s for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A comma-separated environment variable as a list. */
export function listFromEnv(name: string, fallback: string[]): string[] {
  const value = process.env[name];
  if (!value) return fallback;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
