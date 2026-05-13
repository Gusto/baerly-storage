import type { JSONArrayless, JSONArraylessObject } from "./json.ts";

/**
 * Handle on one table (collection). Chainable: `where`, `order`,
 * `limit` return a `Query<T>`; `insert`, `count` are terminal
 * verbs that fire I/O on the spot.
 *
 * @template T — the document shape. Documents always carry an
 *              auto-generated `_id` (UUIDv7); the type system
 *              treats `_id` as optional on `insert` (server fills
 *              it in) and required on read.
 */
export interface Table<T extends JSONArraylessObject = JSONArraylessObject> {
  readonly name: string;

  /**
   * Filter by exact equality on top-level or dotted-path fields.
   * Day-one operator policy: equality + dotted-path only — no
   * `$or` / `$gt` / `$in` / `$regex`. Calling `.where(...)` twice
   * AND-merges the predicates.
   *
   * @example
   * ```ts
   * db.table("tickets").where({ status: "open" }).all();
   * db.table("tickets").where({ "assignee.team": "platform" }).all();
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
   * terminal called on it (including `count()`).
   */
  consistency(level: ConsistencyLevel): Query<T>;

  /**
   * Insert a new document. UUIDv7 auto-id on `_id`; caller can
   * supply `_id` and the server honours it. Returns the new id.
   *
   * @throws BaerlyError{code: "Conflict"} — `_id` collision on
   *         caller-supplied id.
   * @throws BaerlyError{code: "SchemaError"} — malformed JSON, or
   *         schema-validation failure (not yet wired).
   */
  insert(doc: Partial<T> & JSONArraylessObject): Promise<{ _id: string }>;

  /** Count every row in the table (equivalent to `.where({}).count()`). */
  count(): Promise<number>;
}

/**
 * Predicate over a document shape. Today: equality only. Top-level
 * keys (`{ status: "open" }`) and dotted-path keys
 * (`{ "assignee.team": "platform" }`). Values are
 * `JSONArrayless` — string / number / boolean / nested object for
 * equality on a sub-tree. A future change may widen the value
 * type (e.g. `{ $in: [...] }`); the shape change will be additive.
 */
export type Predicate<T extends JSONArraylessObject = JSONArraylessObject> = {
  readonly [K in keyof T]?: T[K];
} & {
  readonly [dottedPath: string]: JSONArrayless;
};

/** Order specifier. Top-level fields only on day one. */
export type OrderSpec<T extends JSONArraylessObject = JSONArraylessObject> = {
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
 * terminal.
 */
export interface Query<T extends JSONArraylessObject = JSONArraylessObject> {
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
   * Hint the read path to satisfy the predicate via a declared
   * secondary index. When the matching index entries are walked
   * the read path skips the snapshot-fold-and-table-scan and
   * issues a content GET per index entry.
   *
   * Last-call-wins on repeat invocation. Today this is an opt-in:
   * the predicate must be `{ <indexedField>: <value> }` shape and
   * the index must be single-field. Mismatches fall back to the
   * full table scan with a metric bump.
   *
   * Index reads are best-effort: if the index is stale (the
   * rebuild hasn't run since a crashed commit) the index walk may
   * return rows whose docs no longer exist or no longer match the
   * predicate. The reader filters them via a final in-memory
   * predicate re-check, so an out-of-sync index never produces
   * wrong rows — only at worst surfaces a stale row that the
   * predicate then drops.
   *
   * A future change adds a query planner that auto-picks an index
   * when one matches the predicate shape; until then callers opt
   * in explicitly with `.useIndex(name)`.
   *
   * @example
   * ```ts
   * await db.table("tickets")
   *   .where({ status: "open" })
   *   .useIndex("by_status")
   *   .all();
   * ```
   */
  useIndex(name: string): Query<T>;

  /** First match or `undefined`. Equivalent to `.limit(1).all()[0]`. */
  first(): Promise<T | undefined>;

  /**
   * Every matching document, respecting `order` and `limit`. No
   * implicit cap — callers should always pair `.all()` with
   * `.limit(n)` on large tables.
   */
  all(): Promise<T[]>;

  /** Count matching rows. Cheaper than `(await all()).length`. */
  count(): Promise<number>;

  /**
   * JSON-merge-patch (RFC 7386) applied to every matching doc.
   * Atomic per row. `null` at any field deletes it.
   *
   * @throws BaerlyError{code: "Conflict"} — concurrent write lost
   *         the CAS race. Caller's choice whether to retry.
   * @throws BaerlyError{code: "SchemaError"} — patch produced an
   *         invalid doc.
   */
  update(patch: Partial<T>): Promise<{ modified: number }>;

  /**
   * Whole-document replace on the first matching row. Throws
   * `BaerlyError{code: "Conflict"}` if zero or more than one row
   * matches — `replace` is intentionally narrow.
   */
  replace(doc: T): Promise<void>;

  /** Delete every matching document. */
  delete(): Promise<{ deleted: number }>;
}
