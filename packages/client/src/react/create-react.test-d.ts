/**
 * Type-level assertions for {@link createBaerlyReact}. The regression
 * this guards is the one that made `useQuery((c) => ...)` force a
 * `as Promise<Note[]>` cast: the React surface must thread `TConfig`
 * so `c.collection("notes").all()` infers the real row type.
 *
 * Validated by `tsgo --noEmit` (via `pnpm verify`). Not picked up by
 * vitest — `.test-d.ts` is outside the default include glob.
 */

import { defineConfig, type DocumentData, type SchemaValidator } from "@baerly/protocol";
import type { BaerlyClient } from "../client.ts";
import { createBaerlyReact } from "./create-react.ts";
import type { UseQueryResult } from "./use-query.ts";

// Minimal validator stand-in — independent of zod / valibot so this
// file pulls no runtime dep. Mirrors `client.test-d.ts`.
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

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

const { useQuery, useMutation, useBaerlyClient } = createBaerlyReact<typeof config>();

// (A) The headline fix: a bound `useQuery` infers the row type from
// the collection name with NO cast. Before the factory, the callback
// saw `BaerlyClient<UnboundConfig>` and `.all()` was `DocumentData[]`.
const boundList = () => useQuery((c) => c.collection("tickets").all(), []);
export type _BoundListInfersTickets = Expect<
  Equal<ReturnType<typeof boundList>, UseQueryResult<(TicketShape & DocumentData)[]>>
>;

// (B) `.get(id)` flows the same row shape through the discriminated union.
const boundGet = () => useQuery((c) => c.collection("tickets").get("id"), []);
export type _BoundGetInfersTicket = Expect<
  Equal<ReturnType<typeof boundGet>, UseQueryResult<(TicketShape & DocumentData) | undefined>>
>;

// (C) `useBaerlyClient` returns the bound client, not the unbound one.
export type _BoundUseClient = Expect<
  Equal<ReturnType<typeof useBaerlyClient>, BaerlyClient<typeof config>>
>;

// (D) `useMutation` callbacks receive the bound client — `insert`
// accepts the schema's partial shape.
export const _boundMutate = () => {
  const [mutate] = useMutation();
  return mutate((c) => c.collection("tickets").insert({ title: "hi", status: "open" }));
};

// (E) No type parameter → unbound surface: names widen to `string`,
// rows to `DocumentData`. Matches the in-process `Db.collection` fallback.
const unbound = createBaerlyReact();
const unboundList = () => unbound.useQuery((c) => c.collection("anything").all(), []);
export type _UnboundDefaultsToDocumentData = Expect<
  Equal<ReturnType<typeof unboundList>, UseQueryResult<(Record<string, unknown> & DocumentData)[]>>
>;
