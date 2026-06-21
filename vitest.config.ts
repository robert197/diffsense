import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@diffsense/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@diffsense/llm": fileURLToPath(new URL("./packages/llm/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      // apps/web uses `lib/` (not `src/`); its pure auth/github helpers test here.
      "apps/web/lib/**/*.test.ts",
      // Route-handler tests (e.g. the OAuth callback CSRF guard) live under app/.
      "apps/web/app/**/*.test.ts",
    ],
    environment: "node",
  },
});
