/* eslint-disable no-unused-vars -- `S` on `Db<S>` is reserved for the Phase 9
   schema registry; it parametrises only the public type, not any member yet. */

import type { JSONArrayless, JSONArraylessObject } from "./json";
import type { LogEntry } from "./log";
import type { Storage } from "./storage";
import type { ResolvedRef } from "./types";

/**
 * Schema map — `{ [tableName]: documentShape }`. Phase 2 default
 * is `Record<string, JSONArraylessObject>`. Phase 9 upgrades this
 * to a Zod/Valibot/ArkType registry without breaking `Db<S>`.
 */
export type SchemaMap = Record<string, JSONArraylessObject>;

/**
 * Public entry point — one `Db` per `(app, tenant)` pair.
 *
 * Tenant is a **required** constructor argument. The lint rule
 * `no-tenantless-db-ctor` (Phase 2) fails the build on any
 * construction that omits `tenant`. One bucket per app; tenants
 * are prefix-scoped inside the bucket (see ADR-0006).
 *
 * @example
 * ```ts
 * import { Db } from "@baerly/protocol";
 * import { LocalFsStorage } from "@baerly/dev";
 *
 * const db = new Db({
 *   app: "tickets",
 *   tenant: "acme-co",
 *   storage: new LocalFsStorage({ root: "./.baerly-dev" }),
 * });
 *
 * await db.table("tickets").insert({ title: "Reset password" });
 * const open = await db.table("tickets").where({ status: "open" }).all();
 * ```
 */
export declare class Db<S extends SchemaMap = SchemaMap> {
  constructor(config: { app: string; tenant: string; storage: Storage });

  /**
   * Typed handle for a single table. Cheap; creates no I/O. Same
   * name returns the same `Table<T>` *shape* across calls but not
   * necessarily the same object identity — compare by name, not
   * `===`.
   */
  table<T extends JSONArraylessObject = JSONArraylessObject>(name: string): Table<T>;

  /**
   * Atomic mutation over a **single** table. The callback receives
   * a `Table<T>` (not a `Db`), so cross-table writes inside a
   * transaction are a TypeScript error at compile time — not a
   * runtime trap. Single-attempt: on CAS conflict the body throws
   * `MPS3Error{code: "Conflict"}`; wrap in a retry loop *you wrote*
   * if you want one. ADR-0019 records the scope decision.
   *
   * @example
   * ```ts
   * await db.transaction("tickets", async (tx) => {
   *   const open = await tx.where({ status: "open" }).count();
   *   if (open < 100) await tx.insert({ title: "another", status: "open" });
   * });
   * ```
   *
   * @throws MPS3Error{code: "Conflict"} — CAS lost on the table's
   *         `current.json`. The body ran but the commit didn't win.
   */
  transaction<T extends JSONArraylessObject = JSONArraylessObject>(
    table: string,
    body: (tx: Table<T>) => Promise<void>,
  ): Promise<void>;

  /**
   * Escape hatch to the protocol layer. Stable but undocumented for
   * non-engineers; Claude should prefer `db.table(...)`. Use only
   * when you need raw `LogEntry` emit or a point-`get` on a
   * `ResolvedRef`.
   *
   * @internal — public symbol, but the table API is the
   *             recommended surface.
   */
  readonly _raw: RawApi;
}

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
   * Insert a new document. UUIDv7 auto-id on `_id`; caller can
   * supply `_id` and the server honours it. Returns the new id.
   *
   * @throws MPS3Error{code: "Conflict"} — `_id` collision on
   *         caller-supplied id.
   * @throws MPS3Error{code: "SchemaError"} — malformed JSON, or
   *         (Phase 9) schema-validation failure.
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
 * equality on a sub-tree. Phase 9 may widen the value type
 * (e.g. `{ $in: [...] }`); the shape change will be additive.
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
 * `Table<T>` after at least one modifier. Carries predicate /
 * order / limit state forward. Modifiers compose; verbs are
 * terminal.
 */
export interface Query<T extends JSONArraylessObject = JSONArraylessObject> {
  where(predicate: Predicate<T>): Query<T>;
  order(spec: OrderSpec<T>): Query<T>;
  limit(n: number): Query<T>;

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
   * @throws MPS3Error{code: "Conflict"} — concurrent write lost
   *         the CAS race. Caller's choice whether to retry.
   * @throws MPS3Error{code: "SchemaError"} — patch produced an
   *         invalid doc.
   */
  update(patch: Partial<T>): Promise<{ modified: number }>;

  /**
   * Whole-document replace on the first matching row. Throws
   * `MPS3Error{code: "Conflict"}` if zero or more than one row
   * matches — `replace` is intentionally narrow.
   */
  replace(doc: T): Promise<void>;

  /** Delete every matching document. */
  delete(): Promise<{ deleted: number }>;
}

/**
 * Low-level surface — bypass the table API. Useful for adapters,
 * log replay, or emitting an `M` (MESSAGE) `LogEntry`.
 */
export interface RawApi {
  /**
   * Append one `LogEntry`. CAS on `current.json` runs underneath.
   *
   * @throws MPS3Error{code: "SchemaError"} — body is not valid
   *         JSON or contains an array where `JSONArrayless` is
   *         required.
   */
  put(entry: LogEntry): Promise<void>;

  /** Read the doc at a `ResolvedRef`, or `undefined` on miss. */
  get(ref: ResolvedRef): Promise<JSONArraylessObject | undefined>;
}
