// Bundles spec/schema/*.schema.json into spec/protocol.schema.json: one schema whose $defs are
// every file's $defs, with refs between files made local. The code generators read the bundle.
// Usage: node scripts/bundle-schema.mjs

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "spec/schema");
const files = readdirSync(dir).filter((f) => f.endsWith(".schema.json")).sort();

const defs = {};
for (const file of files) {
  const schema = JSON.parse(readFileSync(join(dir, file), "utf8"));
  for (const [name, def] of Object.entries(schema.$defs ?? {})) {
    if (name in defs) throw new Error(`${file}: $defs/${name} is also defined in another file`);
    defs[name] = localRefs(def, file);
  }
}

function localRefs(node, file) {
  if (Array.isArray(node)) return node.map((n) => localRefs(n, file));
  if (node === null || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$ref") {
      const m = /^(?:([\w.-]+\.schema\.json))?#\/\$defs\/(\w+)$/.exec(v);
      if (!m) throw new Error(`${file}: unsupported $ref ${v}`);
      if (m[1] && !files.includes(m[1])) throw new Error(`${file}: $ref to missing file ${m[1]}`);
      out[k] = `#/$defs/${m[2]}`;
    } else out[k] = localRefs(v, file);
  }
  return out;
}

for (const [name, def] of Object.entries(defs)) {
  JSON.stringify(def, (k, v) => {
    if (k === "$ref" && !(v.slice("#/$defs/".length) in defs)) throw new Error(`$defs/${name}: $ref to missing ${v}`);
    return v;
  });
}

const bundle = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/dire-kiwi/agent-threads/spec/protocol.schema.json",
  title: "agent-threads protocol",
  description: "Generated from spec/schema/*.schema.json by scripts/bundle-schema.mjs. Don't edit.",
  $defs: defs,
};
writeFileSync(join(root, "spec/protocol.schema.json"), JSON.stringify(bundle, null, 2) + "\n");
