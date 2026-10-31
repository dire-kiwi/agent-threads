// Strips what mustn't be in a committed recording: absolute paths of the machine that recorded it
// (the temporary working directory, config dirs, the home directory, this checkout), account
// details, and anything that looks like a secret. The recorder runs it over every entry.

import { execFileSync } from "node:child_process";
import { hostname, homedir, userInfo } from "node:os";

/**
 * @param {Array<[string, string]>} paths [real path, what to show instead], e.g. [tmp/work, "/work"]
 */
export function sanitizer(paths) {
  const pairs = [];
  for (const [from, to] of paths) {
    pairs.push([from, to]);
    // Claude names its per-project directories after the path with the separators dashed.
    pairs.push([from.replace(/[^a-zA-Z0-9]/g, "-"), to.replace(/[^a-zA-Z0-9]/g, "-")]);
  }
  pairs.push([homedir(), "/home/user"]);
  // The recording machine's own git email, wherever it might have leaked in.
  try {
    const email = execFileSync("git", ["config", "user.email"], { encoding: "utf8" }).trim();
    if (email) pairs.push([email, "user@example.com"]);
  } catch {}
  pairs.sort((a, b) => b[0].length - a[0].length);
  const user = userInfo().username;
  const host = hostname();

  const str = (s) => {
    for (const [from, to] of pairs) s = s.split(from).join(to);
    if (host.length > 3) s = s.split(host).join("host");
    return s.replace(new RegExp(`\\b${user}\\b`, "g"), "user");
  };

  const walk = (v) => {
    if (typeof v === "string") return str(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        const r = scrubKey(k, x);
        if (r !== DROP) o[str(k)] = walk(r);
      }
      return o;
    }
    return v;
  };

  // Streamed text arrives in pieces that can split a path, so each stream's pieces are joined,
  // cleaned together and cut again at the same places (a replaced path goes in the piece it began).
  const streams = (entries) => {
    const groups = new Map();
    for (const e of entries) {
      const ref = deltaRef(e);
      if (!ref) continue;
      if (!groups.has(ref.key)) groups.set(ref.key, []);
      groups.get(ref.key).push(ref);
    }
    for (const refs of groups.values()) {
      const whole = refs.map((r) => r.get()).join("");
      const { out, map } = replaceMapped(whole, pairs);
      if (out === whole) continue;
      let at = 0;
      for (const r of refs) {
        const len = r.get().length;
        r.set(out.slice(map[at], map[at + len]));
        at += len;
      }
    }
  };

  return (entries) => {
    streams(entries);
    return entries.map((entry) => {
      const e = walk(entry);
      const text = JSON.stringify(e);
      for (const re of SECRETS) {
        if (re.test(text)) throw new Error(`a recording entry still looks like it has a secret (${re}): ${text.slice(0, 300)}`);
      }
      return e;
    });
  };
}

/** s with each pair's from replaced by its to, and where each position of s ended up in it. */
function replaceMapped(s, pairs) {
  let out = "";
  const map = new Array(s.length + 1);
  let i = 0;
  outer: while (i < s.length) {
    for (const [from, to] of pairs) {
      if (from && s.startsWith(from, i)) {
        for (let k = 0; k < from.length; k++) map[i + k] = out.length;
        out += to;
        i += from.length;
        continue outer;
      }
    }
    map[i] = out.length;
    out += s[i++];
  }
  map[s.length] = out.length;
  return { out, map };
}

/** The streamed piece of text an entry carries, if it's one, and which stream it's part of. */
function deltaRef(e) {
  const m = e.msg;
  if (e.dir !== "out" || !m) return null;
  if (m.type === "stream_event" && m.event?.type === "content_block_delta") {
    const d = m.event.delta;
    const field = ["text", "thinking", "partial_json"].find((f) => typeof d[f] === "string");
    if (!field) return null;
    const key = `${e.run}|${m.parent_tool_use_id}|${m.api_message_id ?? m.event.message_id}|${m.event.index}|${field}`;
    return { key, get: () => d[field], set: (v) => (d[field] = v) };
  }
  if (typeof m.method === "string" && /Delta$/.test(m.method) && typeof m.params?.delta === "string") {
    const p = m.params;
    const key = `${e.run}|${m.method}|${p.threadId}|${p.itemId}|${p.summaryIndex ?? p.contentIndex ?? ""}`;
    return { key, get: () => p.delta, set: (v) => (p.delta = v) };
  }
  return null;
}

const DROP = Symbol("drop");

/** Account details and machine specifics, by key, wherever they appear. */
function scrubKey(k, v) {
  switch (k) {
    case "account": // Claude's initialize response, Codex's account/read
      return v && typeof v === "object" ? { email: "user@example.com", organization: "Example Org", subscriptionType: "pro" } : v;
    case "email":
      return typeof v === "string" ? "user@example.com" : v;
    case "rate_limit_info": // Claude's rate_limit_event
      return { status: "allowed", resetsAt: 1800000000, rateLimitType: "seven_day" };
    case "rateLimits": // Codex's account/rateLimits/updated
      return {};
    case "installationId":
      return typeof v === "string" ? "00000000-0000-0000-0000-000000000000" : v;
    case "messaging_socket_path":
    case "userAgent":
      return DROP;
    case "organization":
    case "organizationName":
    case "orgName":
      return typeof v === "string" ? "Example Org" : v;
    default:
      return v;
  }
}

const SECRETS = [/sk-ant-[A-Za-z0-9_-]{8,}/, /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, /Bearer [A-Za-z0-9._-]{16,}/];
