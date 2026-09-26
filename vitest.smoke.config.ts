import { defineConfig } from "vitest/config";

import { loadEnv } from "./packages/core/src/cli/env.ts";
import base from "./vitest.config.ts";

// Keys and tokens saved in .env count, the same as for the CLI. Variables set in the shell win.
loadEnv();

// Opt-in tests against the real services: `npm run test:smoke`. See smoke/README.md.
export default defineConfig({
  resolve: base.resolve,
  test: {
    include: ["smoke/**/*.smoke.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // One service at a time, so output stays readable and slow streams don't compete.
    fileParallelism: false,
  },
});
