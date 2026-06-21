/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // `@diffsense/core` and `@diffsense/llm` are pure-TS workspace packages
  // (export `./src/index.ts`, no compiled dist), so Next must transpile them like
  // first-party app code. `@diffsense/llm` is the LLM seam the deck read path uses
  // to localize card prose (issue #28); it is only ever imported server-side.
  transpilePackages: ["@diffsense/core", "@diffsense/llm"],
  webpack: (config) => {
    // `@diffsense/core` uses ESM-TS imports with explicit `.js` extensions
    // (e.g. `./diff/demote.js`) that resolve to `.ts` sources under TypeScript's
    // NodeNext resolution. Teach webpack the same mapping so the build resolves
    // them instead of looking for non-existent compiled `.js` files.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
