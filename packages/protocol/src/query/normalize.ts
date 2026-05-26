/**
 * Object-form → wire normaliser. Walks a `Predicate<T>` object
 * literal, flattens nested sub-predicates to dotted-path `eq`
 * clauses, and returns a {@link PredicateWire}. Rejects any
 * `$`-prefixed key as `InvalidConfig` — the operator vocabulary
 * lives on the callback DSL only.
 *
 * Semantic invariant: a sub-predicate object (every value is itself
 * an object) flattens to one `eq` clause per leaf — the same
 * open-world matching today's matcher delivers at
 * `./matches.ts:matchesValue` for sub-predicates.
 *
 * Companion modules: `./builder.ts` (callback → wire),
 * `./wire.ts` (types).
 */

import { BaerlyError } from "../errors.ts";
import type { DocumentData } from "../json.ts";
import type { Predicate } from "../table-api.ts";

import { type PredicateArg, type PredicateBuilder, wireFromBuilder } from "./builder.ts";
import type { PredicateClause, PredicateWire } from "./wire.ts";

// Inlined so the normaliser's chunk does not pull in `_internals.ts`
// (which carries the merger/validator's heavier comparator helpers
// the client never executes). Keeping a tiny local copy of formatPath
// keeps the SPA bundle's predicate footprint to normalize+wire only.
const formatPath = (path: ReadonlyArray<string>): string =>
  path.length === 0 ? "<root>" : path.map((p) => JSON.stringify(p)).join(".");

/**
 * Walk an object-literal predicate, emit one `PredicateClause[]`.
 * Pure primitive values become `eq` clauses at the current path;
 * nested objects recurse, flattening to dotted-path clauses.
 *
 * @internal Tested via the public `normalizePredicateArg` and the
 *           normalize.test.ts suite.
 */
export const normalizeObject = (
  obj: DocumentData,
  basePath: ReadonlyArray<string>,
): PredicateClause[] => {
  const out: PredicateClause[] = [];
  for (const key of Object.keys(obj)) {
    const path = [...basePath, key];
    if (key.startsWith("$")) {
      throw new BaerlyError(
        "InvalidConfig",
        `Unsupported predicate operator ${JSON.stringify(key)} at ${formatPath(basePath)} — operator vocabulary moved to the callback form (.where(q => q.gt(field, value))). $-keys are not accepted in object-form predicates.`,
      );
    }
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new BaerlyError(
        "InvalidConfig",
        `Reserved key ${JSON.stringify(key)} not allowed in a predicate at ${formatPath(basePath)}.`,
      );
    }
    const value: unknown = (obj as Record<string, unknown>)[key];
    if (value === null || value === undefined) {
      throw new BaerlyError(
        "InvalidConfig",
        `Predicate value at ${formatPath(path)} is ${value === null ? "null" : "undefined"} — terminal values must be string / number / boolean / nested object.`,
      );
    }
    if (Array.isArray(value)) {
      throw new BaerlyError(
        "InvalidConfig",
        `Predicate value at ${formatPath(path)} is an array — match nested objects with a sub-predicate or use callback form (q.in(field, values)) for set membership.`,
      );
    }
    const t = typeof value;
    if (t === "object") {
      // Sub-predicate — recurse, accumulating dotted path. Object-form
      // predicates have NO operator vocabulary, so a nested object is
      // unambiguously a literal sub-predicate. Empty object `{}` at a
      // nested position is a match-all sub-clause: it emits zero
      // clauses for that subtree, which matches the matcher's
      // pre-redesign behaviour for `{ assignee: {} }` (an empty
      // sub-predicate accepts any non-null object actual).
      const inner = normalizeObject(value as DocumentData, path);
      for (const c of inner) {
        out.push(c);
      }
      continue;
    }
    if (t !== "string" && t !== "number" && t !== "boolean") {
      throw new BaerlyError(
        "InvalidConfig",
        `Predicate value at ${formatPath(path)} has unsupported type ${JSON.stringify(t)} — must be string / number / boolean / nested object.`,
      );
    }
    if (t === "number" && !Number.isFinite(value as number)) {
      throw new BaerlyError(
        "InvalidConfig",
        `Predicate value at ${formatPath(path)} is ${String(value)} — finite numbers only (NaN / Infinity do not round-trip through JSON).`,
      );
    }
    out.push({ op: "eq", field: path.join("."), value: value as string | number | boolean });
  }
  return out;
};

/**
 * Dispatch the two-shape `.where(...)` argument to a
 * {@link PredicateWire}. The object-form is walked by
 * {@link normalizeObject}; the callback form is invoked with a
 * fresh {@link PredicateBuilder}.
 *
 * @internal — every consumer (`Db.table().where`,
 *             `ClientTable.where`, `parseWhereParam`'s wire-arrival
 *             path) routes through this single seam so the wire
 *             format has exactly one parser path.
 */
export const normalizePredicateArg = <T extends DocumentData>(
  arg: PredicateArg<T>,
): PredicateWire => {
  if (typeof arg === "function") {
    return wireFromBuilder<T>(arg as (q: PredicateBuilder<T>) => PredicateBuilder<T>);
  }
  return { clauses: normalizeObject(arg as DocumentData, []) };
};

/**
 * Re-export the public `Predicate<T>` so callers downstream of this
 * module don't need a separate import. Mirrors the old
 * `./_internals.ts:PredicateOp` re-export the kernel used to lean
 * on.
 */
export type { Predicate };
