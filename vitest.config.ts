import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^jev-events\/public$/, replacement: src("./packages/core/src/public/index.ts") },
      { find: /^jev-events\/testing$/, replacement: src("./packages/core/src/testing.ts") },
      { find: /^jev-events$/, replacement: src("./packages/core/src/index.ts") },
      { find: /^@jev-events\/twitch$/, replacement: src("./packages/twitch/src/index.ts") },
      { find: /^@jev-events\/google$/, replacement: src("./packages/google/src/index.ts") },
      { find: /^@jev-events\/slack$/, replacement: src("./packages/slack/src/index.ts") },
    ],
  },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "evals/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      // The testing examples in the docs run for real, so they can't rot.
      "apps/web/snippets/testing*.ts",
    ],
  },
});
