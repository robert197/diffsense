/**
 * Tailwind v4 is wired through its PostCSS plugin so Next's webpack build compiles
 * `app/globals.css` (which `@import`s Tailwind) like any other stylesheet. No
 * `tailwind.config.js` is needed — the design tokens live in `globals.css` under
 * `@theme` (Tailwind v4's CSS-first config).
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
