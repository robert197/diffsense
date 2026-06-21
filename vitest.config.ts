import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@diffsense/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@diffsense/llm": fileURLToPath(new URL("./packages/llm/src/index.ts", import.meta.url)),
    },
  },
  // `.tsx` component tests (e.g. the swipe deck) compile through esbuild; use the
  // automatic JSX runtime so the test files need no explicit React import.
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      // apps/web uses `lib/` (not `src/`); its pure helpers + component tests run here.
      "apps/web/lib/**/*.test.{ts,tsx}",
      // Route-handler tests (OAuth CSRF guard) and the SwipeDeck component test.
      "apps/web/app/**/*.test.{ts,tsx}",
    ],
    // Default to Node; `.tsx` component tests opt into jsdom via a per-file
    // `// @vitest-environment jsdom` docblock so the pure suites stay DOM-free.
    environment: "node",
  },
});
