// The frontend (web/), built to web/dist for the server to serve. Under `vite` (pnpm dev) it's
// served on :5173, and /ws goes to the server on $PORT.

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = `http://127.0.0.1:${process.env.PORT || 3001}`;

export default defineConfig({
  root: "web",
  plugins: [react()],
  // One React, however the workspace links the packages.
  resolve: { dedupe: ["react", "react-dom"] },
  server: { port: 5173, proxy: { "/ws": { target: server, ws: true } } },
  build: { outDir: "dist", emptyOutDir: true },
});
