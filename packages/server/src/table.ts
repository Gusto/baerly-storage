/**
 * Phase-4 read-side entrypoint: `Table<T>` factory. `Db.table(name)`
 * returns the result of `makeTable(ctx)` — a cheap, no-I/O handle
 * that delegates every modifier to `makeQuery` with a fresh empty
 * seed state.
 *
 * The `Table.insert` mutator is on the locked `Table<T>` interface
 * (`@baerly/protocol/src/db.ts`) so we can't omit it from the
 * returned object without breaking the type contract. It throws
 * `MPS3Error{code:"Internal"}` with a message naming ticket 10 —
 * narrow enough that tests can discriminate by `code` without
 * string-matching, and ticket 10 will overwrite this method.
 */

import {
  type JSONArraylessObject,
  MPS3Error,
  type OrderSpec,
  type Predicate,
  type Table,
} from "@baerly/protocol";
import { makeQuery, type TableReadContext } from "./query";

/**
 * Build a `Table<T>` bound to one `(tenant, table)` read context.
 * Cheap: zero I/O, allocates one closure. Each modifier call returns
 * a FRESH `Query<T>` — calling `.where(p1)` and `.where(p2)` on the
 * same `Table<T>` produces two independent chains.
 *
 * `.count()` shorthand defers to the empty-state `Query<T>.count()`
 * so the fold logic lives in one place.
 *
 * @example
 * ```ts
 * const table = makeTable<Ticket>({
 *   storage,
 *   tablePrefix: "app/tickets/tenant/acme/manifests/tickets",
 *   tableName: "tickets",
 * });
 * const open = await table.where({ status: "open" }).all();
 * ```
 *
 * @internal
 */
export const makeTable = <T extends JSONArraylessObject>(ctx: TableReadContext): Table<T> => {
  // Empty seed state. Every modifier merges into a frozen copy.
  const seed = {
    predicate: undefined as Predicate<T> | undefined,
    order: undefined as OrderSpec<T> | undefined,
    limit: undefined as number | undefined,
  };
  return {
    name: ctx.tableName,
    where: (p) => makeQuery<T>(ctx, { ...seed, predicate: p }),
    order: (s) => makeQuery<T>(ctx, { ...seed, order: s }),
    limit: (n) => makeQuery<T>(ctx, { ...seed, limit: n }),
    insert: () => {
      // Deferred to ticket 10. Keep the throw narrow so tests can
      // discriminate by `code` without string-matching.
      throw new MPS3Error(
        "Internal",
        "Table.insert is not implemented in ticket 09 (read-only). Mutations land in ticket 10.",
      );
    },
    count: () => makeQuery<T>(ctx, seed).count(),
  };
};
