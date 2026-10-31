// Ladle (pnpm stories): a page per component, fed by the fixtures' event streams in spec/fixtures.
export default {
  stories: "src/stories/**/*.stories.tsx",
  viteConfig: new URL("./vite.config.mjs", import.meta.url).pathname,
  outDir: "stories-build",
  addons: { theme: { enabled: true, defaultState: "light" }, width: { enabled: true } },
};
