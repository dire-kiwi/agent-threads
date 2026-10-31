// Checks values against the protocol's schemas (schema.ts, generated from spec/), e.g. a command
// from a client before a backend acts on it. It handles the JSON Schema the spec uses ($ref, oneOf,
// type, const, enum, required, properties, additionalProperties, items, minItems, minimum, the
// date-time format and base64 content) and no more, so it needs no dependencies. Fields a schema
// doesn't name are allowed, as the protocol says receivers ignore them.

import { schema } from "./schema.js";

type Schema = {
  $ref?: string;
  oneOf?: Schema[];
  const?: unknown;
  enum?: unknown[];
  type?: string | string[];
  required?: string[];
  properties?: { [k: string]: Schema };
  additionalProperties?: Schema | boolean;
  items?: Schema;
  minItems?: number;
  minimum?: number;
  format?: string;
  contentEncoding?: string;
};

const defs = schema.$defs as { [name: string]: Schema };

/** The names of the protocol's definitions: Command, ThreadEvent, Snapshot... */
export type SchemaName = keyof typeof defs & string;

function deref(s: Schema | undefined): Schema | undefined {
  while (s?.$ref) s = defs[s.$ref.replace("#/$defs/", "")];
  return s;
}

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const show = (v: unknown) => JSON.stringify(v);

/**
 * What's wrong with `value` as the definition `name` (e.g. "Command"), as "path: problem"
 * strings; none when it's valid.
 */
export function validate(value: unknown, name: SchemaName): string[] {
  const s = defs[name];
  if (!s) throw new Error(`the protocol has no definition ${name}`);
  return check(value, s, "");
}

function check(v: unknown, schema: Schema, path: string): string[] {
  const s = deref(schema);
  if (!s) return [];
  const at = path || "(the value)";
  if (s.oneOf) {
    // A union told apart by `type`: check the branch it names; otherwise exactly one must fit.
    const branches = s.oneOf.map(deref).filter((b): b is Schema => !!b);
    const type = v && typeof v === "object" ? (v as { type?: unknown }).type : undefined;
    const named = branches.find((b) => b.properties?.type?.const !== undefined && b.properties.type.const === type);
    if (named) return check(v, named, path);
    if (branches.every((b) => b.properties?.type?.const !== undefined)) {
      return [`${at}: type should be one of ${branches.map((b) => show(b.properties!.type!.const)).join(", ")}, not ${show(type)}`];
    }
    const fits = branches.filter((b) => !check(v, b, path).length).length;
    return fits === 1 ? [] : [`${at}: matches ${fits} of the ${branches.length} possibilities, not exactly one`];
  }
  if ("const" in s && show(v) !== show(s.const)) return [`${at}: should be ${show(s.const)}`];
  if (s.enum && !s.enum.some((x) => show(x) === show(v))) return [`${at}: should be one of ${s.enum.map(show).join(", ")}, not ${show(v)}`];
  if (s.type) {
    const types = ([] as string[]).concat(s.type);
    const t = typeOf(v);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) return [`${at}: should be ${types.join(" or ")}, not ${t}`];
  }
  const errors: string[] = [];
  if (typeof v === "number" && s.minimum !== undefined && v < s.minimum) errors.push(`${at}: should be at least ${s.minimum}`);
  if (typeof v === "string" && s.format === "date-time" && !DATE_TIME.test(v)) errors.push(`${at}: should be a date-time`);
  if (typeof v === "string" && s.contentEncoding === "base64" && !BASE64.test(v)) errors.push(`${at}: should be base64`);
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${at}: should have at least ${s.minItems} entries`);
    if (s.items) v.forEach((x, i) => errors.push(...check(x, s.items!, `${path}[${i}]`)));
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as { [k: string]: unknown };
    for (const k of s.required ?? []) if (!(k in o) || o[k] === undefined) errors.push(`${at}: is missing ${k}`);
    for (const [k, x] of Object.entries(o)) {
      if (x === undefined) continue;
      const p = s.properties?.[k] ?? (typeof s.additionalProperties === "object" ? s.additionalProperties : undefined);
      if (p) errors.push(...check(x, p, `${path}.${k}`));
      else if (s.additionalProperties === false) errors.push(`${at}: shouldn't have ${k}`);
    }
  }
  return errors;
}
