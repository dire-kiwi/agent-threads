// Ids the backend picks: threads, turns, requests, and the items it makes itself.

import { randomBytes } from "node:crypto";

/** A new id, `<prefix>_<time><random>`, so ids made later sort later. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}
