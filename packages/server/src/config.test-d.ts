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

// Bound: passing `config` captures TConfig and lets `db.table(name)`
// infer the row shape from `collections[name].schema`.
const db = Db.create({
  storage: memStorage,
  app: "a",
  tenant: "t",
  config,
});

// `db.table("tickets")` resolves to the narrowing overload —
// `RowOf<typeof config, "tickets"> & DocumentData`. We check
// `first()`'s return shape so the assertion stays scoped to public
// surface (and bypasses Table's internal generic plumbing). The
// per-step `typeof` capture works around TS's reluctance to evaluate
// `typeof db.table<"tickets">` directly. Uses a non-`_id` predicate
// because `Path<T>` excludes the root `_id` key — the row-shape
// inference doesn't depend on the predicate field anyway.
const boundTable = db.table("tickets");
const boundRow = await boundTable.where({ status: "open" }).first();
export type _BoundDbInfersRow = Expect<
  Equal<
    typeof boundRow,
    ({ _id: string; title: string; status: "open" | "closed" } & DocumentData) | undefined
  >
>;

// Legacy path: no `config` passed → `Db<UnboundConfig>`. The
// `table<T>(name)` overload's per-call generic is the only way to
// recover a row shape. Verifies that the legacy DX is preserved.
const dbLegacy = Db.create({ storage: memStorage, app: "a", tenant: "t" });
const legacyTable = dbLegacy.table<{ _id: string; n: number }>("any");
const legacyRow = await legacyTable.where({ n: 1 }).first();
export type _LegacyDbCallSiteGenericStillWorks = Expect<
  Equal<typeof legacyRow, { _id: string; n: number } | undefined>
>;

// Fallthrough: a name that is NOT in `CollectionNames<typeof config>`
// must not produce a type error — overload #1 fails to match, overload
// #2 fires with its default `T = DocumentData`, and the call
// returns `Table<DocumentData>`. Locks in the documented intent
// in `Db.table` and mirrors `BaerlyClient.table`'s behavior. Regression
// guard: if a future "narrow-only" single-overload pattern lands, this
// assertion breaks and forces the change to be deliberate. `Path<T>`
// falls back to bare `string` on `DocumentData`, so `_id` is still a
// legal predicate key here — useful evidence that the filter only
// fires on typed shapes.
const typoTable = db.table("notACollection");
const typoRow = await typoTable.where({ _id: "x" }).first();
export type _BoundDbUnknownNameFallsBackToDocumentData = Expect<
  Equal<typeof typoRow, DocumentData | undefined>
>;

export const _idIsNotAPredicateKeyOnTypedTables = () => {
  // @ts-expect-error — `_id` is excluded from `Path<T>` on typed shapes.
  void boundTable.where({ _id: "x" });
  // @ts-expect-error — same on the legacy per-call-generic shape.
  void legacyTable.where({ _id: "x" });
};
