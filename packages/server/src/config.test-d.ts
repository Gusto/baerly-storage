/**
 * Type-level assertions for the typed-config surface:
 *
 *   - `config.ts` — `RowOf` / `CollectionNames` helpers.
 *   - `db.ts`     — `Db<TConfig>` overload resolution (bound narrow
 *                   path vs legacy per-call generic), including the
 *                   unknown-collection-name fallthrough that the
 *                   public docs promise.
 *
 * Validated by `tsgo --noEmit` (via `pnpm verify`). Not picked up by
 * vitest — the `.test-d.ts` extension is outside the default
 * include glob (see `vitest.config.ts`).
 */

import {
  type CollectionNames,
  defineConfig,
  type DocumentData,
  type RowOf,
  type SchemaValidator,
  type Storage,
} from "@baerly/protocol";
import { Db } from "./db.ts";

// Minimal in-test stand-in for a real validator. We don't depend on
// `zod` here — the type-level check is "does `RowOf` recover the
// `TOutput` parameter of `SchemaValidator<TInput, TOutput>`?",
// which is independent of any specific library.
const ticketSchema = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({
      value: value as { _id: string; title: string; status: "open" | "closed" },
    }),
  },
} as const satisfies SchemaValidator<
  unknown,
  { _id: string; title: string; status: "open" | "closed" }
>;

const config = defineConfig({
  collections: {
    tickets: { schema: ticketSchema },
    audits: {},
  },
});

// `Equal<X, Y>` is the standard TS "are these two types exactly
// equal?" trick. `(<T>() => T extends X ? 1 : 2)` paired against
// `(<T>() => T extends Y ? 1 : 2)` is the cleanest known way to
// force strict equality (not just bidirectional assignability),
// which is what we want for these assertions.
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// `CollectionNames` lifts the literal key-set off the inferred
// config type. With the `<const C>` parameter on `defineConfig`,
// the keys are `"tickets" | "audits"` — not `string`.
type Names = CollectionNames<typeof config>;
export type _NamesIsLiteralUnion = Expect<Equal<Names, "tickets" | "audits">>;

// `RowOf<config, "tickets">` recovers the schema output type.
type Ticket = RowOf<typeof config, "tickets">;
export type _TicketRecoversSchemaOutput = Expect<
  Equal<Ticket, { _id: string; title: string; status: "open" | "closed" }>
>;

// `RowOf<config, "audits">` falls back to `Record<string, unknown>`
// because no schema was declared for `audits`.
type Audit = RowOf<typeof config, "audits">;
export type _AuditFallsBackToRecord = Expect<Equal<Audit, Record<string, unknown>>>;

// The `_*` aliases above are `export type` rather than module-local
// declarations specifically because `noUnusedLocals: true` flags
// unused type aliases regardless of the leading-underscore prefix
// (the underscore-ignore only applies to value-level locals and
// parameters). Exporting makes them part of the module's public
// surface — which is fine, since the entire `.test-d.ts` file is a
// type-only assertion module and is not re-exported through any
// barrel.

// --- Db<TConfig> assertions (T3) -------------------------------

// Pin a `Storage` value at the type level only. We never instantiate
// it — only `Db.create({ storage, ... })`'s signature is exercised.
// `declare const` is the standard TS idiom for synthesising a typed
// value for type-test purposes without runtime cost.
declare const memStorage: Storage;

// Bound: passing `config` captures TConfig and lets `db.collection(name)`
// infer the row shape from `collections[name].schema`.
const db = Db.create({
  storage: memStorage,
  app: "a",
  tenant: "t",
  config,
});

// `db.collection("tickets")` against the bound config resolves to the
// narrowing overload — `RowOf<typeof config, "tickets"> & DocumentData`.
// We check `first()`'s return shape so the assertion stays scoped to
// public surface (and bypasses Collection's internal generic plumbing).
// Uses a non-`_id` predicate because `Path<T>` excludes the root `_id`
// key — the row-shape inference doesn't depend on the predicate field
// anyway.
const boundCollection = db.collection("tickets");
const boundRow = await boundCollection.where({ status: "open" }).first();
export type _BoundDbInfersRow = Expect<
  Equal<
    typeof boundRow,
    ({ _id: string; title: string; status: "open" | "closed" } & DocumentData) | undefined
  >
>;

// Unbound-config path: no `config` passed → `Db<UnboundConfig>`.
// `CollectionNames<UnboundConfig>` widens to `string`, so any string
// name typechecks; the row type defaults to `DocumentData` (via
// `RowOf<UnboundConfig, K>` fallback intersected with `DocumentData`
// at the `Collection<T extends DocumentData>` seam).
const dbLegacy = Db.create({ storage: memStorage, app: "a", tenant: "t" });
const legacyCollection = dbLegacy.collection("any");
const legacyRow = await legacyCollection.where({}).first();
export type _UnboundDbRowDefaultsToDocumentData = Expect<
  Equal<typeof legacyRow, (Record<string, unknown> & DocumentData) | undefined>
>;

export const _typoOnBoundConfigIsCompileError = () => {
  // @ts-expect-error — `"notACollection"` is not in `CollectionNames<typeof config>`.
  void db.collection("notACollection");
};

export const _idIsNotAPredicateKeyOnTypedTables = () => {
  // @ts-expect-error — `_id` is excluded from `Path<T>` on typed shapes.
  void boundCollection.where({ _id: "x" });
};
