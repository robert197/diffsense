/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // `@diffsense/core` is a pure-TS workspace package (exports `./src/index.ts`,
  // no compiled dist), so Next must transpile it like first-party app code.
  transpilePackages: ["@diffsense/core"],
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
