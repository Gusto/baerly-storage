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
   * `id` need not be NFC, so a row an earlier release stored under a
   * non-NFC id stays readable.
   *
   * @throws BaerlyError{code: "InvalidConfig"} — `id` is not a valid
   *         `_id`: empty, over 256 UTF-8 bytes, containing `/` or a
   *         control character, a leading `_`, or `.` / `..` (HTTP 400).
   *         No row can be stored under such an id; nothing was read.
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
   * Operator vocabulary is locked to {@link PredicateBuilder}'s
   * method list; invoking anything else is a TS compile error.
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
   * Insert a new document. UUIDv7 auto-id when `_id` is absent,
   * `undefined` or `""`; caller can supply `_id` and the server honours
   * it. Returns the new id.
   *
   * A supplied `_id` must be a string; any other present value (`null`,
   * a number, a boolean, an object) throws rather than being replaced
   * by a generated id. A non-empty one must be of at most 256 UTF-8
   * bytes with no `/`, no control characters, no leading `_`, not `.` or
   * `..`, and in Unicode Normalization Form C
   * (`id === id.normalize("NFC")`). Ids that differ only by case are
   * distinct.
   *
   * @throws BaerlyError{code: "InvalidConfig"} — the supplied `_id`
   *         is not a string or breaks one of those rules; nothing was
   *         written. Pass `id.normalize("NFC")` for a non-NFC id.
   * @throws BaerlyError{code: "AlreadyExists"} — caller-supplied `_id`
   *         is held by a live row, including one a concurrent insert
   *         committed first: of concurrent inserts of one `_id`, exactly
   *         one commits and the others throw this, committing nothing.
   *         Not retriable: insert under another `_id`, omit `_id`, or use
   *         `update` / `replace`.
   * @throws BaerlyError{code: "WriteConflict"} — concurrent write won
   *         the CAS race and this commit did not land. Retriable.
   * @throws BaerlyError{code: "AmbiguousCommit"} — a committing
   *         create may be durable, but its outcome could not be
   *         resolved, so the row may or may not have been inserted.
   *         `err._id` is the row's id, minted or supplied: re-read it
   *         (absence is not proof of failure), and retry with that same
   *         `_id` so a retry cannot mint a second document.
   *         Not retriable-by-default; handle the code explicitly.
   * @throws BaerlyError{code: "CapacityExceeded"} — the collection is
   *         at the serving host's fold ceiling and this write would
   *         grow it (or no fold can make progress on this host); nothing
   *         was committed. Not retriable unchanged; see RECIPES.md.
   * @throws BaerlyError{code: "MaintenancePending"} — maintenance is behind
   *         on this collection; nothing was committed. Retriable: wait
   *         `err.retryAfter` seconds, then repeat the call.
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
   * Returns `{ modified: 0 }` when no row exists at `id` (over HTTP,
   * `404 NotFound`).
   *
   * **Concurrent writes to the row.** The patch is applied to the row's
   * newest committed version, not to the version this call read: if
   * another write to `id` commits between the read and this commit, the
   * patch is re-applied on top of it, so neither write's fields are lost.
   * If the row was deleted in between, nothing is committed and the call
   * returns `{ modified: 0 }` (even if the `_id` was inserted again
   * since: that is a new row this call never read). No error is thrown
   * for either race (PostgreSQL READ COMMITTED semantics).
   *
   * @throws BaerlyError{code: "WriteConflict"} — part of the log this
   *         commit had to check was retired by maintenance before it
   *         could be read, or a storage precondition was rejected;
   *         nothing was committed. Retriable: re-run the call.
   * @throws BaerlyError{code: "AmbiguousCommit"} — a committing
   *         create may be durable, but its outcome could not be
   *         resolved, so the update may or may not have been applied.
   *         Re-read by `id` (also `err._id`); absence is not proof of failure.
   *         Not retriable-by-default; handle the code explicitly.
   * @throws BaerlyError{code: "CapacityExceeded"} — the collection is
   *         at the serving host's fold ceiling and this write would
   *         grow it (or no fold can make progress on this host); nothing
   *         was committed. Not retriable unchanged; see RECIPES.md.
   * @throws BaerlyError{code: "MaintenancePending"} — maintenance is behind
   *         on this collection; nothing was committed. Retriable: wait
   *         `err.retryAfter` seconds, then repeat the call.
   * @throws BaerlyError{code: "SchemaError"} — patch produced an
   *         invalid doc.
   * @throws BaerlyError{code: "InvalidConfig"} — the patch's
   *         top-level `_id` is present and is not the row's `_id`
   *         (`null` included). A patch cannot re-key or strip a row;
   *         omit `_id`, or pass the row's own `_id`. Also thrown when
   *         the row's `_id` is not NFC (stored by an earlier release):
   *         such a row can be read and deleted but not updated. Insert a
   *         copy under a fresh NFC id that is not canonically equivalent
   *         to the original (for example, omit `_id` for a UUID), then
   *         delete the original. On R2, using the normalized original id
   *         would let that delete remove the copy's index markers.
   * @throws BaerlyError{code: "InvalidResponse"} — the stored row's
   *         `_id` is not the string `id`. Repair it with
   *         `replace(id, doc)`.
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
   * **Concurrent writes to the row.** Last writer wins: an update that
   * commits between this call's read and its commit is overwritten by
   * `doc`. A delete that commits there is not undone: nothing is
   * committed and the call throws `NotFound`.
   *
   * @throws BaerlyError{code: "NotFound"} — no row exists at `id`,
   *         including one a concurrent delete removed after this call
   *         read it. Nothing was committed.
   * @throws BaerlyError{code: "WriteConflict"} — part of the log this
   *         commit had to check was retired by maintenance before it
   *         could be read, or a storage precondition was rejected;
   *         nothing was committed. Retriable: re-run the call.
   * @throws BaerlyError{code: "AmbiguousCommit"} — a committing
   *         create may be durable, but its outcome could not be
   *         resolved, so the replace may or may not have been applied.
   *         Re-read by `id` (also `err._id`); absence is not proof of failure.
   *         Not retriable-by-default; handle the code explicitly.
   * @throws BaerlyError{code: "CapacityExceeded"} — the collection is
   *         at the serving host's fold ceiling and this write would
   *         grow it (or no fold can make progress on this host); nothing
   *         was committed. Not retriable unchanged; see RECIPES.md.
   * @throws BaerlyError{code: "MaintenancePending"} — maintenance is behind
   *         on this collection; nothing was committed. Retriable: wait
   *         `err.retryAfter` seconds, then repeat the call.
   * @throws BaerlyError{code: "InvalidConfig"} — `id` breaks the `_id`
   *         rules on {@link Collection.insert}, including NFC; nothing
   *         was written.
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
   * delete, use `.where(predicate).delete()` on {@link Query}. `id`
   * need not be NFC, so a row stored under a non-NFC id by an earlier
   * release can still be deleted.
   *
   * **Concurrent writes to the row.** A delete applies to the row this
   * call read. If that row was deleted between the read and this commit
   * (by a racing delete, even if its `_id` was inserted again since),
   * nothing is committed and the call returns `{ deleted: 0 }`, so of two
   * racing deletes one reports `1` and the other `0`. A concurrent update
   * does not stop it: the row is deleted.
   *
   * @throws BaerlyError{code: "WriteConflict"} — part of the log this
   *         commit had to check was retired by maintenance before it
   *         could be read, or a storage precondition was rejected;
   *         nothing was committed. Retriable: re-run the call.
   * @throws BaerlyError{code: "AmbiguousCommit"} — a committing
   *         create may be durable, but its outcome could not be
   *         resolved, so the tombstone may or may not have been
   *         applied. Re-read by `id` (also `err._id`); absence is not
   *         proof of failure. Not retriable-by-default; handle the code
   *         explicitly.
   * @throws BaerlyError{code: "CapacityExceeded"} — the collection is
   *         at the serving host's fold ceiling and this write would
   *         grow it (or no fold can make progress on this host); nothing
   *         was committed. Not retriable unchanged; see RECIPES.md.
   * @throws BaerlyError{code: "InvalidResponse"} — the stored row's
   *         `_id` is not the string `id` (left by an older release
   *         that let a patch strip or re-key `_id`). Repair it with
   *         `replace(id, doc)`.
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
 * **Operators live on the callback form only.** Range / `in` /
 * mixed eq+range queries write
 * `.where(q => q.gt("priority", 5).in("status", ["open", "pending"]))`.
 * That vocabulary lives on {@link PredicateBuilder} (see there for
 * the locked method list); object-form has no `$`-keyed surface, so
 * an operator we never implemented cannot be invoked from either
 * shape. For OR/AND:
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
   * applied to every matching doc. `null` at any field deletes it. For
   * the single-row case prefer {@link Collection.update}(id, patch).
   *
   * Each row commits on its own (there is no multi-row transaction): a
   * failure part-way leaves the rows before it applied. `modified`
   * counts the rows this call committed.
   *
   * **Concurrent writes to a matched row.** Each row's patch is applied
   * to its newest committed version, not to the version this call read.
   * If another write to the row commits between the read and the row's
   * commit, the predicate is evaluated again on that newest version
   * (`order` and `limit` are not): if it still matches, the patch is
   * re-applied on top of it, so neither write's fields are lost; if not,
   * the row is skipped. A row deleted in between is skipped too (even if
   * its `_id` was inserted again since). Skipped rows are not counted in
   * `modified`, and no error is thrown (PostgreSQL READ COMMITTED
   * semantics).
   *
   * @throws BaerlyError{code: "WriteConflict"} — part of the log one
   *         row's commit had to check was retired by maintenance before
   *         it could be read, or a storage precondition was rejected; that
   *         row did not commit. Rows before it may already be applied;
   *         re-issuing the call is safe (it re-reads and re-matches).
   *         Retriable.
   * @throws BaerlyError{code: "AmbiguousCommit"} — one row's
   *         committing create may be durable, but its outcome could
   *         not be resolved. Rows before it are already applied; the
   *         partial-progress `modified` count is NOT returned. `err._id`
   *         names that row; absence is not proof of failure.
   * @throws BaerlyError{code: "CapacityExceeded"} — the collection is
   *         at the serving host's fold ceiling and the batch would grow
   *         it (or no fold can make progress on this host). Decided for the
   *         whole batch before any row commits, and again at a row's commit
   *         if a concurrent write landed since; rows before that one are
   *         then already applied. Not retriable unchanged; see RECIPES.md.
   * @throws BaerlyError{code: "MaintenancePending"} — maintenance is behind
   *         on this collection; the refused row and the rows after it were
   *         not committed. Retriable: wait `err.retryAfter` seconds, then
   *         repeat the call.
   * @throws BaerlyError{code: "SchemaError"} — patch produced an
   *         invalid doc, including when re-applied to a row's newest
   *         version at its commit (rows before it are then applied).
   * @throws BaerlyError{code: "InvalidConfig"} — the patch's
   *         top-level `_id` is present and is not a matched row's
   *         `_id` (`null` included), or a matched row's `_id` is not
   *         NFC (see {@link Collection.update}). Checked for every
   *         matched row before any row commits.
   * @throws BaerlyError{code: "InvalidResponse"} — a matched stored
   *         row's `_id` is not the string it is stored under (left by
   *         an older release). Checked for every matched row before any
   *         row commits. Repair it with `replace(id, doc)`.
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
   * Each row commits on its own; `deleted` counts the rows this call
   * deleted.
   *
   * **Concurrent writes to a matched row.** If another write to a matched
   * row commits between this call's read and the row's commit, the
   * predicate is evaluated again on that newest version (`order` and
   * `limit` are not), and the row is deleted only if it still matches. A
   * row already deleted in between (even if its `_id` was inserted again
   * since) is skipped. Skipped rows are not counted in `deleted`, and no
   * error is thrown (PostgreSQL READ COMMITTED semantics).
   *
   * @throws BaerlyError{code: "WriteConflict"} — part of the log one
   *         row's commit had to check was retired by maintenance before
   *         it could be read, or a storage precondition was rejected; that
   *         row did not commit. Rows before it may already be tombstoned;
   *         re-issuing the call is safe (it re-reads and re-matches).
   *         Retriable.
   * @throws BaerlyError{code: "AmbiguousCommit"} — one row's
   *         committing create may be durable, but its outcome could
   *         not be resolved. Rows before it are already tombstoned;
   *         the partial-progress `deleted` count is NOT returned.
   *         `err._id` names that row; re-read before deciding whether
   *         to resume.
   * @throws BaerlyError{code: "CapacityExceeded"} — the collection is
   *         at the serving host's fold ceiling and the batch would grow
   *         it (or no fold can make progress on this host). Decided for the
   *         whole batch before any row commits, and again at a row's commit
   *         if a concurrent write landed since; rows before that one are
   *         then already applied. Not retriable unchanged; see RECIPES.md.
   * @throws BaerlyError{code: "InvalidResponse"} — a matched stored
   *         row's `_id` is not the string it is stored under (left by
   *         an older release). Checked for every matched row before any
   *         row commits. Repair it with `replace(id, doc)`.
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
