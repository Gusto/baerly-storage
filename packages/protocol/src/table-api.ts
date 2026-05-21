import type { DocumentValue, DocumentData } from "./json.ts";
import type { PredicateOp } from "./query/_internals.ts";

/**
 * Handle on one table (collection). The common single-row case lives
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
export interface Table<T extends DocumentData = DocumentData> {
  readonly name: string;

  /**
   * First document in the whole collection or `undefined` when the
   * collection is empty. Equivalent to `.where({}).first()`.
   *
   * @example
   * ```ts
   * const any = await db.table("tickets").first();
   * ```
   */
  first(): Promise<T | undefined>;

  /**
   * Every document in the whole collection. Equivalent to
   * `.where({}).all()`. No implicit cap — prefer
   * `.where(p).limit(n).all()` on large tables.
   *
   * @example
   * ```ts
   * const all = await db.table("tickets").all();
   * ```
   */
  all(): Promise<T[]>;

  /**
   * Count every row in the table (equivalent to `.where({}).count()`).
   *
   * @example
   * ```ts
   * const total = await db.table("tickets").count();
   * ```
   */
  count(): Promise<number>;

  /**
   * Fetch one document by primary key. Equivalent to
   * `.where({ _id: id }).first()`. Returns `undefined` when the id
   * is unknown — does not throw `NotFound`.
   *
   * @example
   * ```ts
   * const ticket = await db.table("tickets").get(id);
   * if (ticket === undefined) {
   *   // row not in this table
   * }
   * ```
   */
  get(id: string): Promise<T | undefined>;

  /**
   * Filter by equality on top-level or dotted-path fields, or by a
   * per-field operator object. Supported operator vocabulary:
   * `$eq`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`. Multiple operators
   * on the same field AND together (`{ count: { $gte: 1, $lt: 10 } }`).
   * Not supported: top-level boolean connectives (`$or`, `$and`),
   * `$regex`, and any other operator — `validatePredicate` rejects
   * them as `InvalidConfig`. Calling `.where(...)` twice AND-merges
   * the predicates.
   *
   * @example
   * ```ts
   * db.table("tickets").where({ status: "open" }).all();
   * db.table("tickets").where({ "assignee.team": "platform" }).all();
   * db.table("tickets").where({ count: { $gte: 1 } }).all();
   * db.table("tickets").where({ status: { $in: ["open", "pending"] } }).all();
   * ```
   */
  where(predicate: Predicate<T>): Query<T>;

  /** Order modifier; last call wins. */
  order(spec: OrderSpec<T>): Query<T>;

  /** Limit modifier; last call wins. */
  limit(n: number): Query<T>;

  /**
   * Read consistency level for the terminal call. Default `strong`.
   * See {@link Query.consistency} for the staleness contract — the
   * level threaded here applies to the `Query<T>` returned and any
   * terminal called on it.
   */
  consistency(level: ConsistencyLevel): Query<T>;

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
   * const { _id } = await db.table("tickets").insert({
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
   * const { modified } = await db.table("tickets")
   *   .update(id, { status: "closed" });
   * ```
   */
  update(id: string, patch: Partial<T>): Promise<{ modified: number }>;

  /**
   * Whole-document replace on one row by primary key. For
   * predicate-aware bulk replace, use `.where(predicate).replace(doc)`
   * on {@link Query}.
   *
   * @example
   * ```ts
   * await db.table("tickets")
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
   * const { deleted } = await db.table("tickets").delete(id);
   * ```
   */
  delete(id: string): Promise<{ deleted: number }>;
}

/**
 * Predicate over a document shape. Today: equality, dotted-path
 * traversal, and an operator vocabulary on field values
 * (`$eq | $gt | $gte | $lt | $lte | $in`).
 *
 * Top-level equality: `{ status: "open" }`.
 * Dotted-path: `{ "assignee.team": "platform" }`.
 * Operator: `{ priority: { $in: ["p1", "p2"] } }` or
 *           `{ created_at: { $gte: "2026-01-01" } }`.
 * Multiple ops AND on one field: `{ count: { $gte: 1, $lt: 10 } }`.
 *
 * An operator object is one whose keys all start with `$`. Mixing
 * operator and non-operator keys on the same object is rejected by
 * `validatePredicate`. Range ops apply only when expected and
 * actual are both `string` or both `number`; other type combos are
 * always-miss (boolean, null, missing, type-mismatched).
 */
export type Predicate<T extends DocumentData = DocumentData> = {
  readonly [K in keyof T]?: T[K] | PredicateOp<T[K] extends DocumentValue ? T[K] : never>;
} & {
  readonly [dottedPath: string]: DocumentValue | PredicateOp<DocumentValue>;
};

/** Order specifier. Top-level fields only on day one. */
export type OrderSpec<T extends DocumentData = DocumentData> = {
  readonly [K in keyof T]?: "asc" | "desc";
};

/**
 * Read consistency knob. See {@link Query.consistency}. `strong` is
 * the default and matches the historic table-API semantics.
 * `eventual` skips the per-call `current.json` GET and serves the
 * view this
 * isolate observed when it last advanced.
 */
export type ConsistencyLevel = "strong" | "eventual";

/**
 * `Table<T>` after at least one modifier. Carries predicate /
 * order / limit state forward. Modifiers compose; verbs are
 * terminal. Mutation verbs here are **predicate-aware bulk** — they
 * apply to every matching row. For the common single-row case
 * (`{ _id }`), prefer {@link Table.update} / {@link Table.replace} /
 * {@link Table.delete}.
 */
export interface Query<T extends DocumentData = DocumentData> {
  where(predicate: Predicate<T>): Query<T>;
  order(spec: OrderSpec<T>): Query<T>;
  limit(n: number): Query<T>;

  /**
   * Read consistency level for the terminal call. Default `strong`.
   *
   * - `strong` (default): every terminal call reads `current.json`
   *   afresh, then folds the log. View reflects every write that
   *   landed before the call.
   * - `eventual`: skips the per-call `current.json` GET. Returns
   *   the view observed when this isolate last advanced
   *   `current.json`; may be one pointer old. A follow-up
   *   `consistency('strong')` re-anchors.
   *
   * Last-call-wins on repeat invocation (matches `.order()` /
   * `.limit()`). Mutations are always strong — no `eventual`
   * mutation path. HTTP mirror: `?consistency=eventual` on the two
   * read routes; any other value →
   * `BaerlyError{code:"InvalidConfig"}`.
   *
   * @example
   * ```ts
   * await db.table("tickets")
   *   .where({ status: "open" })
   *   .consistency("eventual")
   *   .all();
   * ```
   */
  consistency(level: ConsistencyLevel): Query<T>;

  /**
   * First match or `undefined`. Equivalent to `.limit(1).all()[0]`.
   *
   * @example
   * ```ts
   * const oldest = await db.table("tickets")
   *   .where({ status: "open" })
   *   .order({ commit_ts: "asc" })
   *   .first();
   * ```
   */
  first(): Promise<T | undefined>;

  /**
   * Every matching document, respecting `order` and `limit`. No
   * implicit cap — callers should always pair `.all()` with
   * `.limit(n)` on large tables.
   *
   * @example
   * ```ts
   * const open = await db.table("tickets")
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
   * const open = await db.table("tickets")
   *   .where({ status: "open" })
   *   .count();
   * ```
   */
  count(): Promise<number>;

  /**
   * Predicate-aware bulk mutation: JSON-merge-patch (RFC 7386)
   * applied to every matching doc. Atomic per row. `null` at any
   * field deletes it. For the single-row case prefer
   * {@link Table.update}(id, patch).
   *
   * @throws BaerlyError{code: "Conflict"} — concurrent write lost
   *         the CAS race. Caller's choice whether to retry.
   * @throws BaerlyError{code: "SchemaError"} — patch produced an
   *         invalid doc.
   *
   * @example
   * ```ts
   * const { modified } = await db.table("tickets")
   *   .where({ status: "open" })
   *   .update({ status: "closed", closed_at: new Date().toISOString() });
   * ```
   */
  update(patch: Partial<T>): Promise<{ modified: number }>;

  /**
   * Predicate-aware whole-document replace on the first matching
   * row. Throws `BaerlyError{code: "Conflict"}` if zero or more
   * than one row matches — `replace` is intentionally narrow. For
   * the single-row case prefer {@link Table.replace}(id, doc).
   *
   * @example
   * ```ts
   * await db.table("tickets")
   *   .where({ status: "draft" })
   *   .replace({ _id: "01HQ...", status: "open", title: "Rewrite" });
   * ```
   */
  replace(doc: T): Promise<void>;

  /**
   * Predicate-aware bulk delete: every matching document. For the
   * single-row case prefer {@link Table.delete}(id).
   *
   * @example
   * ```ts
   * const { deleted } = await db.table("tickets")
   *   .where({ status: "closed" })
   *   .delete();
   * ```
   */
  delete(): Promise<{ deleted: number }>;
}
