import { BaerlyError } from "./errors.ts";

const INSERT_ID_RESOLUTION =
  "Pass _id as a non-empty string (for example String(value)), or omit it to have one generated.";

/**
 * Reject a present, non-string `_id` on an insert. `undefined` is absent and
 * `""` is a string, so both still get a generated id; `null`, numbers
 * (`-0` and `NaN` included), booleans, objects and arrays throw. Checks the
 * caller's own value, before anything replaces it with a generated id.
 * Shared by the server's insert and the HTTP client's, so the two agree on
 * which ids are generated.
 *
 * @throws BaerlyError code="InvalidConfig" — `id` is present and not a string.
 */
export const assertInsertIdType = (id: unknown): void => {
  if (id !== undefined && typeof id !== "string") {
    throw new BaerlyError(
      "InvalidConfig",
      `insert: _id must be a string, got ${id === null ? "null" : typeof id}`,
      { resolution: INSERT_ID_RESOLUTION },
    );
  }
};

const NON_FINITE_RESOLUTION =
  "JSON cannot represent NaN or Infinity. Store a finite number or null there, or omit the field.";
const UNDEFINED_MEMBER_RESOLUTION =
  "JSON drops a member whose value is undefined. Omit the field, or store null.";
const UNDEFINED_ELEMENT_RESOLUTION =
  "JSON turns an undefined or missing array element into null. Store null there, or remove the element.";
const NON_PLAIN_RESOLUTION =
  "Store plain JSON: convert a Date with date.toISOString(), a Map with Object.fromEntries(map), a Set or typed array with Array.from(value), a boxed primitive with value.valueOf(), and copy a class instance's fields into a plain object.";
const NON_JSON_TYPE_RESOLUTION =
  "Store a string, finite number, boolean, null, plain object or array there. Convert a bigint with String(value); remove functions and symbols.";
const CIRCULAR_RESOLUTION =
  "Remove the circular reference: a document is a tree of plain objects and arrays.";

/** One value awaiting a check, with the link back to its parent for the error path. */
type Pending = {
  readonly value: unknown;
  readonly parent: Pending | undefined;
  readonly key: string | number | undefined;
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const pathOf = (at: Pending): string => {
  let path = "";
  for (let step: Pending | undefined = at; step?.key !== undefined; step = step.parent) {
    const { key } = step;
    let segment = `[${JSON.stringify(key)}]`;
    if (typeof key === "number") {
      segment = `[${key}]`;
    } else if (IDENTIFIER.test(key)) {
      segment = `.${key}`;
    }
    path = segment + path;
  }
  return path.startsWith(".") ? path.slice(1) : path;
};

const refuse = (verb: string, at: Pending, what: string, resolution: string): never => {
  const path = pathOf(at);
  throw new BaerlyError(
    "InvalidConfig",
    path === ""
      ? `${verb}: the document is ${what}`
      : `${verb}: document value at ${path} is ${what}`,
    { resolution },
  );
};

/**
 * Reject a document (or update patch) holding a value JSON cannot store
 * as written. `JSON.stringify` would silently turn `NaN` and `±Infinity`
 * into `null`, drop `undefined` members, turn `undefined` or missing array
 * elements into `null`, and reduce a `Date`, `Map`, typed array, boxed
 * primitive or class instance to a different shape; a function, symbol or
 * bigint would be dropped or throw. Each of those throws here instead,
 * naming the path of the first offending value, as do circular references.
 *
 * Allowed: strings, finite numbers (`-0` included), booleans, `null` (at
 * any depth), arrays, and plain objects (prototype `Object.prototype` or
 * `null`). A top-level `_id: undefined` counts as absent, as on `insert`
 * and in an update patch. No size, depth or `null` limits are applied:
 * those belong to the storage format.
 *
 * Pure and I/O-free. The write verbs call it on the caller's value before
 * any storage call; the HTTP client calls it before serializing, because
 * the coercions above happen in `JSON.stringify` and a server only ever
 * sees their result.
 *
 * @param verb  the calling verb, used as the message prefix
 *   (`"insert"`, `"replace"`, `"update"`, …).
 * @throws BaerlyError code="InvalidConfig" — `value` holds a value outside
 *   the JSON document domain. The message names its path.
 */
export const assertDocumentValues = (value: unknown, verb: string): void => {
  // Explicit work stack, so a deep document does not consume the call
  // stack. `ancestors` holds the containers on the current root-to-node
  // path; a container reached again through its own subtree is a cycle
  // (a container shared by two branches is fine, as in JSON.stringify).
  const pending: Array<Pending | { readonly exit: object }> = [
    { value, parent: undefined, key: undefined },
  ];
  const ancestors = new Set<object>();
  while (pending.length > 0) {
    const next = pending.pop()!;
    if ("exit" in next) {
      ancestors.delete(next.exit);
      continue;
    }
    const current = next.value;
    if (typeof current === "string" || typeof current === "boolean" || current === null) {
      continue;
    }
    if (typeof current === "number") {
      if (Number.isFinite(current)) {
        continue;
      }
      return refuse(verb, next, String(current), NON_FINITE_RESOLUTION);
    }
    if (current === undefined) {
      // A missing array element (a hole) reads as `undefined` too.
      const elementOrMember = typeof next.key === "number";
      return refuse(
        verb,
        next,
        "undefined",
        elementOrMember ? UNDEFINED_ELEMENT_RESOLUTION : UNDEFINED_MEMBER_RESOLUTION,
      );
    }
    if (typeof current !== "object") {
      return refuse(verb, next, `a ${typeof current}`, NON_JSON_TYPE_RESOLUTION);
    }
    if (ancestors.has(current)) {
      return refuse(verb, next, "a circular reference", CIRCULAR_RESOLUTION);
    }
    if (Array.isArray(current)) {
      ancestors.add(current);
      pending.push({ exit: current });
      // Pushed in reverse so the first offending element is reported first.
      for (let i = current.length - 1; i >= 0; i--) {
        pending.push({ value: current[i], parent: next, key: i });
      }
      continue;
    }
    const prototype: unknown = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      const name = (current as { constructor?: { name?: unknown } }).constructor?.name;
      return refuse(
        verb,
        next,
        typeof name === "string" && name !== ""
          ? `a ${name}, not a plain object`
          : "not a plain object",
        NON_PLAIN_RESOLUTION,
      );
    }
    ancestors.add(current);
    pending.push({ exit: current });
    const keys = Object.keys(current);
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]!;
      const member = (current as Record<string, unknown>)[key];
      if (member === undefined && key === "_id" && next.parent === undefined) {
        continue;
      }
      pending.push({ value: member, parent: next, key });
    }
  }
};
