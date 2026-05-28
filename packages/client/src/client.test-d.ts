/**
 * Type-level assertions for `BaerlyClient<TConfig>` /
 * `createBaerlyClient<TConfig>` inference.
 *
 * Validated by `tsgo --noEmit` (via `pnpm verify`). Not picked up by
 * vitest — the `.test-d.ts` extension is outside the default include
 * glob (see `vitest.config.ts`).
 */

import { defineConfig, type DocumentData, type SchemaValidator } from "@baerly/protocol";
import { type ClientCollection, createBaerlyClient } from "./client.ts";

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

// (A) Bound config: `.collection("tickets")` resolves the narrow overload
// and yields `ClientCollection<RowOf<typeof config, "tickets"> &
// DocumentData>`. The intersection comes from the
// `ClientCollection<T extends DocumentData>` constraint at the
// seam — it forwards the constraint without losing the schema's
// output shape.
//
// We bind concrete values to each step of the chain so `typeof` on
// the per-step methods resolves the correct overload (TypeScript's
// `typeof method` on an overloaded method only surfaces the last
// call signature; binding the *result* of the call sidesteps that).
const boundClient = createBaerlyClient({ baseUrl: "", config });
const boundTicketCollection = boundClient.collection("tickets");
// Use a non-`_id` predicate because `Path<T>` excludes the root
// `_id` key on typed shapes; the row-shape inference doesn't depend
// on which field is used.
const boundTicketQuery = boundTicketCollection.where({ status: "open" });
type BoundFirst = Awaited<ReturnType<typeof boundTicketQuery.first>>;
export type _BoundFirstInfersTicket = Expect<
  Equal<BoundFirst, (TicketShape & DocumentData) | undefined>
>;

// Companion assertion: the underlying table handle threads the same
// row shape — this proves the inference flows from `RowOf` directly,
// not from `.where().first()` happening to massage it.
export type _BoundTableHandleInfersRowType = Expect<
  Equal<typeof boundTicketCollection, ClientCollection<TicketShape & DocumentData>>
>;

// (B) No `config` passed: `createBaerlyClient({ baseUrl: "" })` defaults
// `TConfig` to `UnboundConfig`. `CollectionNames<UnboundConfig>` widens
// to `string` so `.collection(anyName)` typechecks; the row type
// defaults to `DocumentData` (via `RowOf<UnboundConfig, K>` →
// `Record<string, unknown>` intersected with `DocumentData` at the
// `Collection<T extends DocumentData>` seam).
const unboundClient = createBaerlyClient({ baseUrl: "" });
const unboundAnyCollection = unboundClient.collection("anything");
type UnboundCollection = typeof unboundAnyCollection;
export type _UnboundCollectionDefaultsToDocumentData = Expect<
  Equal<UnboundCollection, ClientCollection<Record<string, unknown> & DocumentData>>
>;

export const _idIsNotAPredicateKeyOnClientTypedTables = () => {
  // @ts-expect-error — `_id` is excluded from `Path<T>` on typed shapes.
  void boundTicketCollection.where({ _id: "x" });
};

// The `_*` aliases above are exported as `type` rather than declared
// module-local because `noUnusedLocals: true` flags unused type
// aliases regardless of the leading-underscore prefix (the
// underscore-ignore only applies to value-level locals and
// parameters). Exporting makes them part of this module's public
// surface — fine, since the entire `.test-d.ts` file is a type-only
// assertion module and is not re-exported through any barrel.
