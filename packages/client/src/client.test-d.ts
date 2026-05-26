/**
 * Type-level assertions for `BaerlyClient<TConfig>` /
 * `createBaerlyClient<TConfig>` inference.
 *
 * Validated by `tsgo --noEmit` (via `pnpm verify`). Not picked up by
 * vitest — the `.test-d.ts` extension is outside the default include
 * glob (see `vitest.config.ts`).
 */

import { defineConfig, type DocumentData, type SchemaValidator } from "@baerly/protocol";
import { type ClientTable, createBaerlyClient } from "./client.ts";

// Minimal stand-in for a real validator — independent of zod /
// valibot / arktype so the test-d file doesn't pull a runtime dep.
// The shape only needs to satisfy `SchemaValidator<unknown, OutputShape>`
// structurally so `RowOf` can recover `OutputShape`.
type TicketShape = {
  readonly _id: string;
  readonly title: string;
  readonly status: "open" | "closed";
};
const ticketSchema = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value: value as TicketShape }),
  },
} as const satisfies SchemaValidator<unknown, TicketShape>;

const config = defineConfig({
  collections: {
    tickets: { schema: ticketSchema },
  },
});

// Standard "are these two types exactly equal?" helper.
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// (A) Bound config: `.table("tickets")` resolves the narrow overload
// and yields `ClientTable<RowOf<typeof config, "tickets"> &
// DocumentData>`. The intersection comes from the
// `ClientTable<T extends DocumentData>` constraint at the
// seam — it forwards the constraint without losing the schema's
// output shape.
//
// We bind concrete values to each step of the chain so `typeof` on
// the per-step methods resolves the correct overload (TypeScript's
// `typeof method` on an overloaded method only surfaces the last
// call signature; binding the *result* of the call sidesteps that).
const boundClient = createBaerlyClient({ baseUrl: "", config });
const boundTicketTable = boundClient.table("tickets");
// Use a non-`_id` predicate because `Path<T>` excludes the root
// `_id` key on typed shapes; the row-shape inference doesn't depend
// on which field is used.
const boundTicketQuery = boundTicketTable.where({ status: "open" });
type BoundFirst = Awaited<ReturnType<typeof boundTicketQuery.first>>;
export type _BoundFirstInfersTicket = Expect<
  Equal<BoundFirst, (TicketShape & DocumentData) | undefined>
>;

// Companion assertion: the underlying table handle threads the same
// row shape — this proves the inference flows from `RowOf` directly,
// not from `.where().first()` happening to massage it.
export type _BoundTableHandleInfersRowType = Expect<
  Equal<typeof boundTicketTable, ClientTable<TicketShape & DocumentData>>
>;

// (B) No `config` passed: the legacy per-call generic still works.
// `createBaerlyClient({ baseUrl: "" })` defaults `TConfig` to
// `UnboundConfig`, so `CollectionNames<TConfig> = never` and the
// narrow overload is unsatisfiable — overload 2 wins.
const unboundClient = createBaerlyClient({ baseUrl: "" });
type Foo = { _id: string; tag: string };
const unboundFooTable = unboundClient.table<Foo>("anything");
const unboundFooQuery = unboundFooTable.where({ tag: "x" });
type UnboundFirst = Awaited<ReturnType<typeof unboundFooQuery.first>>;
export type _UnboundFirstAcceptsPerCallGeneric = Expect<Equal<UnboundFirst, Foo | undefined>>;

export const _idIsNotAPredicateKeyOnClientTypedTables = () => {
  // @ts-expect-error — `_id` is excluded from `Path<T>` on typed shapes.
  void boundTicketTable.where({ _id: "x" });
  // @ts-expect-error — same for the per-call-generic shape.
  void unboundFooTable.where({ _id: "x" });
};

// The `_*` aliases above are exported as `type` rather than declared
// module-local because `noUnusedLocals: true` flags unused type
// aliases regardless of the leading-underscore prefix (the
// underscore-ignore only applies to value-level locals and
// parameters). Exporting makes them part of this module's public
// surface — fine, since the entire `.test-d.ts` file is a type-only
// assertion module and is not re-exported through any barrel.
