// Vite's import.meta.glob, as the stories use it (Ladle runs them on Vite).
interface ImportMeta {
  glob(pattern: string, options: { query: string; import: string; eager: true }): Record<string, unknown>;
}
