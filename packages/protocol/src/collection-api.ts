import type { DocumentValue, DocumentData } from "./json.ts";
import type { PredicateArg, PredicateBuilder } from "./query/builder.ts";

export type { PredicateArg, PredicateBuilder };

/**
 * Handle on one collection. The common single-row case lives
 * here as direct verbs (`get(id)`, `update(id, patch)`,
 * `replace(id, doc)`, `delete(id)`) plus whole-collection reads
 * (`first()`, `all()`, `count()`). For bulk-by-predicate mutation —
 * or for chained `.where()` / `.order()` / `.limit()` reads — call
 * the modifier verbs to get a {@link Query} back.
 *
 * @template T — the document shape. Documents always carry an
 *              auto-generated `_id` (UUIDv7); the type system
 *              treats `_id` as optional on `insert` (server fills
 *              it in) and required on read.
 */
export interface Collection<T extends DocumentData = DocumentData> {
  readonly name: string;

  /**
   * First document in the whole collection or `undefined` when the
   * collection is empty. Equivalent to `.where({}).first()`.
   *
   * @example
   * ```ts
   * const any = await db.collection("tickets").first();
   * ```
   */
  first(): Promise<T | undefined>;

  /**
   * Every document in the whole collection. Equivalent to
   * `.where({}).all()`. No implicit cap — prefer
   * `.where(p).limit(n).all()` on large collections.
   *
   * @example
   * ```ts
   * const all = await db.collection("tickets").all();
   * ```
   */
  all(): Promise<T[]>;

  /**
   * Count every row in the collection (equivalent to `.where({}).count()`).
   *
   * @example
   * ```ts
   * const total = await db.collection("tickets").count();
   * ```
   */
  count(): Promise<number>;

  /**
   * Fetch one document by primary key. Returns `undefined` when the
   * id is unknown — does not throw `NotFound`.
   *
   * @example
   * ```ts
   * const ticket = await db.collection("tickets").get(id);
   * if (ticket === undefined) {
   *   // row not in this collection
   * }
   * ```
   */
  get(id: string): Promise<T | undefined>;

  /**
   * Filter rows. Two shapes:
   *
   *  - **Object literal** — equality only. Top-level, dotted-path,
   *    or nested-literal sub-predicate.
   *  - **Callback DSL** — `q => q.eq(...).gt(...).in(...)`. The
   *    operator vocabulary (`eq` / `gt` / `gte` / `lt` / `lte` /
   *    `in`) lives here. Chained calls AND-merge inside one
   *    callback; chained `.where(...).where(...)` AND-merges
   *    across calls and across shapes.
   *
   * Methods that do not exist on {@link PredicateBuilder}
   * (`or`, `not`, `regex`, `ne`, `exists`, ...) are intentionally
   * absent — invoking them is a TS compile error.
   *
   * @example
   * ```ts
   * db.collection("tickets").where({ status: "open" }).all();
   * db.collection("tickets").where({ "assignee.team": "platform" }).all();
   * db.collection("tickets").where(q => q.gte("count", 1).lt("count", 10)).all();
   * db.collection("tickets").where(q => q.in("status", ["open", "pending"])).all();
   * db.collection("tickets")
   *   .where({ status: "open" })
   *   .where(q => q.gte("priority", 5))
   *   .all();
   * ```
   */
  where(predicate: PredicateArg<T>): Query<T>;

  /** Order modifier; last call wins. */
  order(spec: OrderSpec<T>): Query<T>;

  /** Limit modifier; last call wins. */
  limit(n: number): Query<T>;

  /**
   * Insert a new document. UUIDv7 auto-id on `_id`; caller can
   * supply `_id` and the server honours it. Returns the new id.
   *
   * @throws BaerlyError{code: "Conflict"} — `_id` collision on
   *         caller-supplied id.
   * @throws BaerlyError{code: "SchemaError"} — malformed JSON, or
   *         schema-validation failure (when a schema is declared
   *         for the collection via `Db.create({ collections })`).
   *
   * @example
   * ```ts
   * const { _id } = await db.collection("tickets").insert({
   *   status: "open",
   *   title: "Ship the docs",
   * });
   * ```
   */
  insert(doc: Partial<T> & DocumentData): Promise<{ _id: string }>;

  /**
   * JSON-merge-patch (RFC 7386) applied to one row by primary key.
   * For predicate-aware bulk mutation, use
   * `.where(predicate).update(patch)` on {@link Query}.
   *
   * @throws BaerlyError{code: "Conflict"} — concurrent write lost
   *         the CAS race. Caller's choice whether to retry.
   * @throws BaerlyError{code: "SchemaError"} — patch produced an
   *         invalid doc.
   *
   * @example
   * ```ts
   * const { modified } = await db.collection("tickets")
   *   .update(id, { status: "closed" });
   * ```
   */
  update(id: string, patch: Partial<T>): Promise<{ modified: number }>;

  /**
   * Whole-document replace on one row by primary key. Throws
   * `BaerlyError{code:"NotFound"}` when no row exists at `id`.
   *
   * @example
   * ```ts
   * await db.collection("tickets")
   *   .replace(id, { _id: id, status: "open", title: "Rewrite" });
   * ```
   */
  replace(id: string, doc: T): Promise<void>;

  /**
   * Delete one row by primary key. Returns `{ deleted: 0 }` when the
   * id is unknown rather than throwing. For predicate-aware bulk
   * delete, use `.where(predicate).delete()` on {@link Query}.
   *
   * @example
   * ```ts
   * const { deleted } = await db.collection("tickets").delete(id);
   * ```
   */
  delete(id: string): Promise<{ deleted: number }>;
}

/**
 * Decrementing depth markers for {@link Path}'s recursion cap.
 * The default of 4 means dotted paths up to `a.b.c.d.e` are legal;
 * `a.b.c.d.e.f` is rejected. Keeps `tsgo` recursion bounded.
 * @internal
 */
type _PathDepth = [never, 0, 1, 2, 3, 4];

/**
 * True when `V` is a value position that should terminate {@link Path}
 * recursion. Primitives, `null`, and arrays are leaves — we do not
 * descend into array indices via dotted-path keys (the runtime
 * evaluator treats every segment as an object key, so `"tags.0"`
 * would resolve to `arr["0"]`, which works but is poor DX).
 * @internal
 */
type _IsPathLeaf<V> = V extends string | number | boolean | null
  ? true
  : V extends ReadonlyArray<unknown>
    ? true
    : false;

/**
 * Strip the string index signature from `T` so {@link Path} can
 * iterate over named keys only. Without this, `T = DocumentData &
 * UserShape` (the canonical user-doc shape across the kernel)
 * collapses `keyof T` to `string` and defeats narrowing.
 *
 * The pattern `string extends K ? never : K` is the standard TS
 * idiom: the parameter of a `[k: string]: …` signature has type
 * `string`, so `string extends string` is true for it (excluded);
 * any literal key like `"status"` does not extend `string`
 * (kept).
 * @internal
 */
type _StripIndex<T> = {
  [K in keyof T as string extends K ? never : K]: T[K];
};

/**
 * Recursively-derived union of every legal dotted-path key over `T`.
 * Depth-capped at 5 segments (`a.b.c.d.e` legal, `a.b.c.d.e.f` not) so
 * the type checker doesn't blow recursion limits on deep schemas.
 *
 * When `T` is just `DocumentData` (the default — no user shape
 * passed), `_StripIndex<T>` is `{}` and `_Keys<T>` is `never`. In
 * that case we fall through to bare `string` keys, preserving
 * today's open-keyed default behavior.
 * @internal
 */
type _AllPaths<T, D extends _PathDepth[number] = 4> = [D] extends [never]
  ? never
  : T extends object
    ? keyof _StripIndex<T> & string extends never
      ? string
      : {
          // Leaf test runs on `NonNullable<T[K]>`: for an optional field the raw
          // `T[K]` is `V | undefined`, and the `undefined` arm defeats the
          // array-is-a-leaf check in `_IsPathLeaf` (a union doesn't extend
          // `ReadonlyArray`), which would otherwise make an optional `string[]`
          // descend into `Array.prototype` and synthesize `foo.map.${string}`.
          [K in keyof _StripIndex<T> & string]: _IsPathLeaf<NonNullable<T[K]>> extends true
            ? K
            : K | `${K}.${_AllPaths<NonNullable<T[K]>, _PathDepth[D]>}`;
        }[keyof _StripIndex<T> & string]
    : never;

/**
 * Legal dotted-path keys over `T`, with the root-level `_id` filtered
 * out so the top-level shape no longer accepts `{ _id: "x" }`. Nested
 * `_id` paths (e.g. `"author._id"`) survive — only the bare `"_id"`
 * head and any literal `"_id.<rest>"` head are excluded (no
 * `_id.<rest>` shape exists today since `_id` is a string leaf, but
 * the template-string guard keeps the contract intact if the doc
 * shape ever changes).
 *
 * When `T = DocumentData` (no user-supplied shape), `_AllPaths<T>`
 * degrades to bare `string` and the `Exclude<>` wrapper leaves that
 * branch unchanged — open-keyed predicates still typecheck.
 * @internal
 */
export type Path<T, D extends _PathDepth[number] = 4> = Exclude<
  _AllPaths<T, D>,
  "_id" | `_id.${string}`
>;

/**
 * Resolves the leaf value type at dotted path `P` through `T`.
 * Paired with {@link Path} to type the value side of
 * {@link Predicate}. `NonNullable` collapses optional intermediate
 * fields so `"a.b"` resolves through `{ a?: { b: number } }`.
 *
 * Falls back to `DocumentValue` when `P` does not resolve to a
 * named key — this only happens when `Path<T> = string` (no user
 * shape), in which case any string is legal and the value side
 * widens to `DocumentValue` to match today's default.
 * @internal
 */
export type PathValue<T, P extends string> = P extends `${infer H}.${infer R}`
  ? H extends keyof T
    ? PathValue<NonNullable<T[H]>, R>
    : never
  : P extends keyof T
    ? T[P]
    : DocumentValue;

/**
 * Recursive partial sub-predicate. The value side of a nested
 * predicate clause: every nested key is optional, and recurses into
 * objects. `_SubPredicate<{a: number, b: {c: string}}>` admits
 * `{a: 1}`, `{b: {c: "x"}}`, and `{a: 1, b: {c: "x"}}` — the same
 * open-world matching the matcher delivers at the wire level
 * (`{ assignee: { team: "x" } }` matches docs where
 * `assignee.team === "x"`, ignoring other keys on `assignee`).
 *
 * Recurses over `keyof T` directly (NOT through `Path<T>`) so the
 * root-level `_id` exclusion does not propagate — a nested `_id`
 * names the primary key of an embedded reference and remains
 * queryable (`.where({ author: { _id: "u1" } })` typechecks).
 * @internal
 */
type _SubPredicate<T> = T extends object
  ? T extends ReadonlyArray<unknown>
    ? never
    : {
        readonly [K in keyof _StripIndex<T> & string]?: T[K] | _SubPredicate<T[K]>;
      }
  : never;

/**
 * Equality-only predicate over a document shape. Object-form
 * accepts:
 *
 *  - top-level equality: `{ status: "open" }`
 *  - dotted-path equality: `{ "assignee.team": "platform" }`
 *  - nested literal sub-predicates: `{ assignee: { team: "platform" } }`
 *    — the normaliser flattens to dotted-path `eq` clauses; the
 *    nested object may carry only a subset of keys (open-world
 *    matching against the document).
 *
 * **Operator vocabulary moved to the callback form.** Range / `in`
 * / mixed eq+range queries write
 * `.where(q => q.gt("priority", 5).in("status", ["open", "pending"]))`.
 * The methods on {@link PredicateBuilder} ARE the supported vocabulary
 * — there is no `$`-keyed object surface, so a method we did not
 * write cannot be called.
 *
 * **No top-level boolean connectives.** `or` / `not` are
 * intentionally absent. Use:
 *   - `q.in(field, ["a", "b"])` for OR over one field.
 *   - Chained `.where(p1).where(p2)` for AND across multiple
 *     predicates — the chain AND-merges.
 *
 * **Depth cap.** Dotted paths are limited to 5 segments
 * (`a.b.c.d.e` legal, `a.b.c.d.e.f` not). Real doc-DB schemas rarely
 * exceed 2–3 levels.
 */
export type Predicate<T extends DocumentData = DocumentData> = {
  readonly [P in Path<T>]?: PathValue<T, P> extends DocumentValue
    ? PathValue<T, P> | _SubPredicate<PathValue<T, P>>
    : DocumentValue;
};

/** Order specifier. Top-level fields only on day one. */
export type OrderSpec<T extends DocumentData = DocumentData> = {
  readonly [K in keyof T]?: "asc" | "desc";
};

/**
 * `Collection<T>` after at least one modifier. Carries predicate /
 * order / limit state forward. Modifiers compose; verbs are
 * terminal. Mutation verbs here are **predicate-aware bulk** — they
 * apply to every matching row. For the common single-row case
 * (`{ _id }`), prefer {@link Collection.update} / {@link Collection.replace} /
 * {@link Collection.delete}.
 */
export interface Query<T extends DocumentData = DocumentData> {
  where(predicate: PredicateArg<T>): Query<T>;
  order(spec: OrderSpec<T>): Query<T>;
  limit(n: number): Query<T>;

  /**
   * First match or `undefined`. Equivalent to `.limit(1).all()[0]`.
   *
   * @example
   * ```ts
   * const oldest = await db.collection("tickets")
   *   .where({ status: "open" })
   *   .order({ commit_ts: "asc" })
   *   .first();
   * ```
   */
  first(): Promise<T | undefined>;

  /**
   * Every matching document, respecting `order` and `limit`. No
   * implicit cap — callers should always pair `.all()` with
   * `.limit(n)` on large collections.
   *
   * @example
   * ```ts
   * const open = await db.collection("tickets")
   *   .where({ status: "open" })
   *   .order({ commit_ts: "desc" })
   *   .limit(50)
   *   .all();
   * ```
   */
  all(): Promise<T[]>;

  /**
   * Count matching rows. Cheaper than `(await all()).length`.
   *
   * @example
   * ```ts
   * const open = await db.collection("tickets")
   *   .where({ status: "open" })
   *   .count();
   * ```
   */
  count(): Promise<number>;

  /**
   * Predicate-aware bulk mutation: JSON-merge-patch (RFC 7386)
   * applied to every matching doc. Atomic per row. `null` at any
   * field deletes it. For the single-row case prefer
   * {@link Collection.update}(id, patch).
   *
   * @throws BaerlyError{code: "Conflict"} — concurrent write lost
   *         the CAS race. Caller's choice whether to retry.
   * @throws BaerlyError{code: "SchemaError"} — patch produced an
   *         invalid doc.
   *
   * @example
   * ```ts
   * const { modified } = await db.collection("tickets")
   *   .where({ status: "open" })
   *   .update({ status: "closed", closed_at: new Date().toISOString() });
   * ```
   */
  update(patch: Partial<T>): Promise<{ modified: number }>;

  /**
   * Predicate-aware bulk delete: every matching document. For the
   * single-row case prefer {@link Collection.delete}(id).
   *
   * @example
   * ```ts
   * const { deleted } = await db.collection("tickets")
   *   .where({ status: "closed" })
   *   .delete();
   * ```
   */
  delete(): Promise<{ deleted: number }>;
}
