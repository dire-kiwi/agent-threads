// The protocol's schemas (spec/protocol.schema.json), for the tools: checking that events are valid
// and knowing which of their fields are required. It handles the JSON Schema the spec uses ($ref,
// oneOf, type, const, enum, required, properties, additionalProperties, items, minItems, minimum and
// the date-time format) and no more, so the tools need no dependencies.

import { readFileSync } from "node:fs";

const bundle = JSON.parse(readFileSync(new URL("../../protocol.schema.json", import.meta.url), "utf8"));

/** A definition by name, e.g. def("ThreadEvent"). */
export const def = (name) => bundle.$defs[name];

/** A schema with its $ref followed. */
export function deref(s) {
  while (s?.$ref) s = bundle.$defs[s.$ref.replace("#/$defs/", "")];
  return s;
}

/** The branch of a oneOf an object belongs to: the one whose `type` const it has. */
export function branch(s, v) {
  s = deref(s);
  if (!s?.oneOf) return s;
  const typed = s.oneOf.map(deref).find((b) => b.properties?.type?.const !== undefined && b.properties.type.const === v?.type);
  return branch(typed ?? s.oneOf.map(deref).find((b) => !validate(v, b).length) ?? s.oneOf[0], v);
}

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

/** What's wrong with a value by a schema, as "path: problem" strings (none when it's valid). */
export function validate(v, schema, path = "") {
  const s = deref(schema);
  if (!s || s === true) return [];
  const at = path || "(the value)";
  if (s.oneOf) {
    const b = branch(s, v);
    if (b.properties?.type?.const !== undefined && b.properties.type.const === v?.type) return validate(v, b, path);
    const ok = s.oneOf.filter((x) => !validate(v, x, path).length).length;
    return ok === 1 ? [] : [`${at}: matches ${ok} of the ${s.oneOf.length} possibilities, not exactly one`];
  }
  if ("const" in s && JSON.stringify(v) !== JSON.stringify(s.const)) return [`${at}: should be ${JSON.stringify(s.const)}`];
  if (s.enum && !s.enum.some((x) => JSON.stringify(x) === JSON.stringify(v))) return [`${at}: should be one of ${s.enum.join(", ")}`];
  if (s.type) {
    const types = [].concat(s.type);
    const t = typeOf(v);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) return [`${at}: should be ${types.join(" or ")}, not ${t}`];
  }
  const errors = [];
  if (typeof v === "number" && s.minimum !== undefined && v < s.minimum) errors.push(`${at}: should be at least ${s.minimum}`);
  if (typeof v === "string" && s.format === "date-time" && !DATE_TIME.test(v)) errors.push(`${at}: should be a date-time`);
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${at}: should have at least ${s.minItems} entries`);
    if (s.items) v.forEach((x, i) => errors.push(...validate(x, s.items, `${path}[${i}]`)));
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of s.required ?? []) if (!(k in v)) errors.push(`${at}: is missing ${k}`);
    for (const [k, x] of Object.entries(v)) {
      const p = s.properties?.[k] ?? (typeof s.additionalProperties === "object" ? s.additionalProperties : undefined);
      if (p) errors.push(...validate(x, p, `${path}.${k}`));
      else if (s.additionalProperties === false) errors.push(`${at}: shouldn't have ${k}`);
    }
  }
  return errors;
}
