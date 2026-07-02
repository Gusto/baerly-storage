/**
 * Type-level assertions for `Predicate<T>` and `PredicateBuilder<T>`
 * narrowing.
 *
 * Closes D13 (string index signature removed) AND the operator-vocab
 * lock-down: the object-form `Predicate<T>` is equality-only — `$gt` /
 * `$in` / etc. are not assignable at compile time. Operator vocabulary
 * lives on the callback DSL (`q => q.gt(...)`), and methods absent
 * from {@link PredicateBuilder} (`or`, `not`, `regex`, `ne`, `exists`)
 * fail typecheck on invocation.
 *
 * Validated by `tsgo --noEmit` (via `pnpm verify`). Not picked up by
 * vitest — the `.test-d.ts` extension is outside the default include
 * glob (see `vitest.config.ts`).
 *
 * Every assertion is `export const` because `noUnusedLocals: true`
 * (see `tsconfig.json`) reports unused locals regardless of the
 * leading-underscore prefix. The file is type-only and not re-exported
 * from any barrel — exporting the assertion handles is harmless.
 */

import { type Path, type Predicate } from "./collection-api.ts";
import type { PredicateArg, PredicateBuilder } from "./query/builder.ts";
import type { DocumentData } from "./json.ts";

// `Ticket` is a `type` intersection with `DocumentData` so it satisfies the
// current `T extends DocumentData` constraint on `Predicate<T>`.  Task 2 will
// remove that constraint; at that point the intersection becomes a no-op and
// the positive cases still compile, while the negative cases still fail.
type Ticket = DocumentData & {
  _id: string;
  status: "open" | "closed";
  count: number;
  done: boolean;
  assignee: { team: string; name: string };
  tags: string[];
};

// --- Positive cases (object form) — must typecheck -----------------

export const _topLevelKey: Predicate<Ticket> = { status: "open" };

export const _dottedKey: Predicate<Ticket> = {
  "assignee.team": "platform",
};

export const _nestedSubPredicate: Predicate<Ticket> = {
  assignee: { team: "platform" },
};

export const _arrayLeafValue: Predicate<Ticket> = { tags: ["x"] };

// --- Negative cases (object form) — each property line must fail ---

export const _misspelledTopLevel: Predicate<Ticket> = {
  // @ts-expect-error — `stutus` is not a key on Ticket
  stutus: "open",
};

export const _wrongTopLevelValueType: Predicate<Ticket> = {
  // @ts-expect-error — status is "open" | "closed", not number
  status: 42,
};

export const _misspelledDottedSegment: Predicate<Ticket> = {
  // @ts-expect-error — assignee has no `tem` field
  "assignee.tem": "x",
};

export const _wrongDottedValueType: Predicate<Ticket> = {
  // @ts-expect-error — assignee.team is string, not number
  "assignee.team": 42,
};

export const _operatorRejectedOnObjectForm: Predicate<Ticket> = {
  // @ts-expect-error — operator vocabulary moved to the callback form
  count: { $gte: 1 },
};

export const _noArrayIndexing: Predicate<Ticket> = {
  // @ts-expect-error — tags is a leaf (array); no "tags.0" path
  "tags.0": "x",
};

// --- Positive cases (callback form) — must typecheck --------------

export const _builderEq: PredicateArg<Ticket> = (q) => q.eq("status", "open");
export const _builderGt: PredicateArg<Ticket> = (q) => q.gt("count", 5);
export const _builderGte: PredicateArg<Ticket> = (q) => q.gte("count", 1);
export const _builderLt: PredicateArg<Ticket> = (q) => q.lt("count", 10);
export const _builderLte: PredicateArg<Ticket> = (q) => q.lte("count", 10);
export const _builderIn: PredicateArg<Ticket> = (q) => q.in("status", ["open", "closed"]);
export const _builderChain: PredicateArg<Ticket> = (q) =>
  q.eq("status", "open").gte("count", 1).lt("count", 10);
export const _builderDottedPath: PredicateArg<Ticket> = (q) => q.eq("assignee.team", "platform");

// --- Negative cases (callback form) — vocabulary lock --------------

export const _builderRegexAbsent: PredicateArg<Ticket> = (q) =>
  // @ts-expect-error — no `regex` method on PredicateBuilder
  q.regex("status", "open");

export const _builderNeAbsent: PredicateArg<Ticket> = (q) =>
  // @ts-expect-error — no `ne` method on PredicateBuilder
  q.ne("status", "open");

export const _builderExistsAbsent: PredicateArg<Ticket> = (q) =>
  // @ts-expect-error — no `exists` method on PredicateBuilder
  q.exists("status");

export const _builderOrAbsent: PredicateArg<Ticket> = (q) =>
  // @ts-expect-error — no `or` method on PredicateBuilder
  q.or([q]);

// --- Negative cases (callback form) — field / value typing --------

export const _builderMisspelledField: PredicateArg<Ticket> = (q) =>
  // @ts-expect-error — "stutus" is not a path on Ticket
  q.eq("stutus", "open");

export const _builderWrongValueType: PredicateArg<Ticket> = (q) =>
  // @ts-expect-error — count is number; eq expects number
  q.eq("count", "1");

export const _builderRangeRejectsBoolean: PredicateArg<Ticket> = (q) =>
  // @ts-expect-error — `done` is boolean; range ops require string|number
  q.gt("done", true);

// --- _id excluded from Path<T> on typed shapes --------------------

type NoteRow = DocumentData & {
  _id: string;
  status: "open" | "closed";
  assignee?: { _id: string; team: string };
};

export const _topLevelNonIdKey: Predicate<NoteRow> = { status: "open" };

export const _dottedNonIdKey: Predicate<NoteRow> = { "assignee.team": "platform" };

export const _nestedIdViaDottedPath: Predicate<NoteRow> = { "assignee._id": "user_123" };

export const _topLevelIdRejected: Predicate<NoteRow> = {
  // @ts-expect-error — `_id` is excluded from `Path<T>`; use `.get(id)` instead.
  _id: "x",
};

export const _builderIdRejected: PredicateArg<NoteRow> = (q) =>
  // @ts-expect-error — `_id` is excluded from `Path<T>` even on the builder.
  q.eq("_id", "x");

export const _misspelledRootKey: Predicate<NoteRow> = {
  // @ts-expect-error — `stutus` is not a key on NoteRow
  stutus: "open",
};

export const _misspelledNestedSegment: Predicate<NoteRow> = {
  // @ts-expect-error — assignee has no `tem` field
  "assignee.tem": "platform",
};

export const _wrongValueTypeForKey: Predicate<NoteRow> = {
  // @ts-expect-error — status is "open" | "closed", not number
  status: 42,
};

// --- Depth-cap boundary --------------------------------------------

type DeepDoc = DocumentData & {
  a: { b: { c: { d: { e: { f: string } } } } };
};

// Positive: 5-segment paths typecheck (cap = 5).
// `"a.b.c.d.e"` must be a key in `Path<DeepDoc>` — confirmed by the
// object literal assignment typechecking without error.
export const _depth5Legal: Predicate<DeepDoc> = {
  "a.b.c.d.e": { f: "x" },
};

// Negative: 6-segment paths fail typecheck.
export const _depth6Rejected: Predicate<DeepDoc> = {
  // @ts-expect-error — depth cap excludes 6-segment paths.
  "a.b.c.d.e.f": "x",
};

// --- PredicateBuilder shape pin — chain returns Builder<T> ---------

export const _builderReturnsSelf = (q: PredicateBuilder<Ticket>): PredicateBuilder<Ticket> =>
  q.eq("status", "open").gt("count", 5);

// --- Optional array/nested fields are Path leaves (regression) -----
// An OPTIONAL array field must terminate `Path` recursion the same as a
// required one. The leaf test in `_AllPaths` runs on `NonNullable<T[K]>`;
// without that guard, `T["tags"]` was `string[] | undefined`, whose
// `undefined` arm defeated the `ReadonlyArray` leaf check, so `_AllPaths`
// descended into `Array.prototype` and synthesized `tags.map.${string}:
// undefined`. That bogus path broke structural assignability for consumers
// whose predicate parameter is an index signature (e.g. a hand-rolled
// `collection(name: string)` shim over a config whose row union contains an
// optional array field). See the matching changeset.
type OptArrayDoc = DocumentData & { kind: string; tags?: string[] };

// The optional array field itself is the only path it contributes.
export const _optArrayIsLeafPath: Path<OptArrayDoc> = "tags";
export const _optArraySiblingPath: Path<OptArrayDoc> = "kind";

// No `Array.prototype` members leak into `Path<T>`.
// @ts-expect-error — `tags.map` is Array.prototype, not a document path.
export const _noArrayPrototypeMap: Path<OptArrayDoc> = "tags.map";
// @ts-expect-error — nor any deeper synthetic prototype path.
export const _noArrayPrototypeDeep: Path<OptArrayDoc> = "tags.map.length";

// Predicate-level: the optional array remains a queryable leaf value.
export const _optArrayLeafValue: Predicate<OptArrayDoc> = { tags: ["x"] };
