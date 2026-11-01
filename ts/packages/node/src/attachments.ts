// A message's attachments in the shapes harnesses take: images with data as images, files with
// textual data as their text, and other files with data written out to a path the agent is told.

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Message } from "./harness.js";

export type Part =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data: string }
  /** An attachment that's a file on disk: one given by path, or one with data, written out. */
  | { type: "path"; kind: "image" | "file"; path: string; name: string; media_type?: string; written?: boolean };

/** Media types whose content goes to the agent as text. */
const TEXTUAL = /^(text\/|application\/(json|xml|yaml|x-yaml|toml|javascript|x-sh|x-ndjson|csv)\b)|\+(json|xml)\b/;

/**
 * A message as parts: its text, then each attachment. Files with data that isn't textual are
 * written to `dir()/attachments/<message id>/`.
 */
export function messageParts(m: Message, dir: () => string): Part[] {
  const parts: Part[] = [{ type: "text", text: m.text }];
  for (const [i, a] of (m.attachments ?? []).entries()) {
    const name = a.name ?? a.path ?? `attachment-${i + 1}`;
    if (a.data !== undefined) {
      if (a.kind === "image") {
        parts.push({ type: "image", media_type: a.media_type ?? "image/png", data: a.data });
        continue;
      }
      const bytes = Buffer.from(a.data, "base64");
      if (a.media_type && TEXTUAL.test(a.media_type)) {
        parts.push({ type: "text", text: `Attached file ${name}:\n${bytes.toString("utf8")}` });
        continue;
      }
      const to = join(dir(), "attachments", m.id);
      mkdirSync(to, { recursive: true });
      const path = join(to, `${i + 1}-${basename(name).replace(/[^\w.-]+/g, "_")}`);
      writeFileSync(path, bytes);
      parts.push({ type: "path", kind: "file", path, name, ...(a.media_type ? { media_type: a.media_type } : {}), written: true });
    } else if (a.path) {
      parts.push({ type: "path", kind: a.kind, path: a.path, name, ...(a.media_type ? { media_type: a.media_type } : {}) });
    }
  }
  return parts;
}

/** What the agent is told about an attachment that's a file on disk. */
export function pathText(p: Extract<Part, { type: "path" }>): string {
  return p.written ? `Attached file ${p.name}${p.media_type ? ` (${p.media_type})` : ""}: ${p.path}` : `Attached file: ${p.path}`;
}
