// Serves the built frontend (web/dist), with index.html for any path that isn't a file.

import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const TYPES: { [ext: string]: string } = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
};

export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  let file = normalize(join(root, path));
  if (!file.startsWith(root + sep)) file = join(root, "index.html");
  const isFile = (f: string) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  };
  if (!isFile(file)) file = join(root, "index.html");
  if (!isFile(file)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("The frontend isn't built: run pnpm build (or use pnpm dev).\n");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    // Vite's assets have their hash in their names; index.html must be fetched fresh.
    "cache-control": file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(file).pipe(res);
}
