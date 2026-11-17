/**
 * Type-level assertions for `MergePatch<T>`, the `update` patch type:
 * `null` deletes an optional key and is refused on a required one,
 * required plain-object members take a nested patch, optional ones take
 * their whole value or `null`, and arrays, scalars and non-plain
 * objects are replaced whole.
 *
 * Validated by `tsgo --noEmit` (via `pnpm verify`). Not picked up by
 * vitest — the `.test-d.ts` extension is outside the default include
 * glob (see `vitest.config.ts`).
 */

import type { Collection } from "./collection-api.ts";
import type { DocumentData, MergePatch } from "./json.ts";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type Ticket = {
  title: string;
  note?: string;
  tags: string[];
  labels?: string[];
  meta: { owner: string; reviewer?: string };
  extra?: { flag?: boolean };
};

// --- Optional vs required keys --------------------------------------

export const _optionalNullDeletes: MergePatch<Ticket> = { note: null };
export const _optionalValue: MergePatch<Ticket> = { note: "n" };
export const _requiredValue: MergePatch<Ticket> = { title: "t" };
export const _emptyPatch: MergePatch<Ticket> = {};
// `undefined` reads as "absent" (no `exactOptionalPropertyTypes`).
export const _undefinedMember: MergePatch<Ticket> = { title: undefined };

// @ts-expect-error — a required key cannot be deleted; use `replace`.
export const _requiredNullRejected: MergePatch<Ticket> = { title: null };

// @ts-expect-error — the value type still binds.
export const _wrongValueType: MergePatch<Ticket> = { title: 1 };

// @ts-expect-error — unknown keys are excess properties, as with `Partial<T>`.
export const _unknownKeyRejected: MergePatch<Ticket> = { nope: 1 };

// --- Nested plain objects recurse -----------------------------------

export const _nestedOptionalNull: MergePatch<Ticket> = { meta: { reviewer: null } };
export const _nestedPartial: MergePatch<Ticket> = { meta: { owner: "ada" } };
export const _nestedWhole: MergePatch<Ticket> = { meta: { owner: "ada", reviewer: "bo" } };
export const _optionalObjectNull: MergePatch<Ticket> = { extra: null };
export const _optionalObjectWhole: MergePatch<Ticket> = { extra: { flag: true } };
export const _optionalObjectWholeEmpty: MergePatch<Ticket> = { extra: {} };
export const _requiredObjectNestedPartial: MergePatch<Ticket> = { meta: { reviewer: "bo" } };

// @ts-expect-error — an optional object takes its whole value or `null`, not a nested patch.
export const _optionalObjectNestedNullRejected: MergePatch<Ticket> = { extra: { flag: null } };

type Doc = { profile?: { name: string; nick?: string } };

// @ts-expect-error — a partial of an optional object is not its whole value; pass `name` too or use `replace`.
export const _optionalObjectPartialRejected: MergePatch<Doc> = { profile: { nick: "x" } };
export const _optionalObjectWholeAccepted: MergePatch<Doc> = { profile: { name: "n" } };

// @ts-expect-error — a nested required key cannot be deleted either.
export const _nestedRequiredNullRejected: MergePatch<Ticket> = { meta: { owner: null } };

// @ts-expect-error — the required nested object itself cannot be deleted.
export const _requiredObjectNullRejected: MergePatch<Ticket> = { meta: null };

// --- Arrays are replaced whole, never recursed ----------------------

export type _ArrayMemberIsTheArray = Expect<
  Equal<NonNullable<MergePatch<Ticket>["tags"]>, string[]>
>;
export const _arrayReplace: MergePatch<Ticket> = { tags: ["a"] };
export const _optionalArrayNull: MergePatch<Ticket> = { labels: null };

// @ts-expect-error — array elements are not patches; `null` is not a `string`.
export const _arrayElementNullRejected: MergePatch<Ticket> = { tags: [null] };

// @ts-expect-error — a required array cannot be deleted.
export const _requiredArrayNullRejected: MergePatch<Ticket> = { tags: null };

type Frozen = { readonly ids: readonly number[]; readonly opt?: readonly string[] };
export type _ReadonlyArrayKeptWhole = Expect<
  Equal<NonNullable<MergePatch<Frozen>["ids"]>, readonly number[]>
>;
export const _readonlyArrayReplace: MergePatch<Frozen> = { ids: [1, 2], opt: null };

// --- Non-plain objects are replaced whole ---------------------------

class Point {
  x = 0;
  y = 0;
}
type WithInstances = { at?: Date; p: Point };
export type _DateKeptWhole = Expect<Equal<NonNullable<MergePatch<WithInstances>["at"]>, Date>>;
export type _ClassInstanceKeptWhole = Expect<
  Equal<NonNullable<MergePatch<WithInstances>["p"]>, Point>
>;

// --- Unions distribute ----------------------------------------------

type Shape = { kind: "circle"; r: number; label?: string } | { kind: "square"; side: number };
export const _unionOptionalNull: MergePatch<Shape> = { label: null };
export const _unionMember: MergePatch<Shape> = { side: 2 };

// @ts-expect-error — `r` is required on the only member that has it.
export const _unionRequiredNullRejected: MergePatch<Shape> = { r: null };

type Slot = { value: string | { id: string; note?: string } };
export const _memberUnionScalar: MergePatch<Slot> = { value: "x" };
export const _memberUnionNestedNull: MergePatch<Slot> = { value: { note: null } };

// --- Untyped rows stay permissive -----------------------------------

export const _documentDataAnyKey: MergePatch<DocumentData> = {
  a: 1,
  b: null,
  c: { d: null, e: [1, "x"] },
};
type Unbound = Record<string, unknown> & DocumentData;
export const _unboundAnyKey: MergePatch<Unbound> = { a: "x", b: null, c: { d: null } };

// A bound row is intersected with `DocumentData` at the collection seam;
// its declared keys keep their required/optional split.
type BoundTicket = Ticket & DocumentData;
export const _boundOptionalNull: MergePatch<BoundTicket> = { note: null };
export const _boundExtraKey: MergePatch<BoundTicket> = { other: null };

// @ts-expect-error — a declared required key stays non-deletable.
export const _boundRequiredNullRejected: MergePatch<BoundTicket> = { title: null };

// --- `Collection.update` / `Query.update` take a `MergePatch<T>` ----

declare const tickets: Collection<BoundTicket>;
declare const notes: Collection<DocumentData>;
export const _verbsTakeMergePatch = async () => {
  await tickets.update("t-1", { note: null, meta: { reviewer: null } });
  await tickets.where({ title: "t" }).update({ note: null });
  await notes.update("n-1", { anything: null });
  // @ts-expect-error — required key: remove it with `replace`.
  await tickets.update("t-1", { title: null });
  // @ts-expect-error — required key on the bulk verb too.
  await tickets.where({ title: "t" }).update({ title: null });
};
