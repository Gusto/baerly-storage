/**
 * Type-level assertions for the `RowOf` / `CollectionNames` helpers.
 *
 * Validated by `tsgo --noEmit` (via `pnpm verify`). Not picked up by
 * vitest — the `.test-d.ts` extension is outside the default
 * include glob (see `vitest.config.ts`).
 */

import type { CollectionNames, RowOf } from "./config.ts";
import { defineConfig } from "./config.ts";
import type { SchemaValidator } from "./schema.ts";

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
