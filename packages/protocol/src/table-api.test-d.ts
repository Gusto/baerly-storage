/**
 * Type-level assertions for `Predicate<T>` narrowing.
 *
 * Closes D13: the string index signature is gone, so misspelled keys
 * and wrong-typed values fail at compile time while the dotted-path
 * ergonomic shape (`{ "a.b": value }`) keeps working.
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

import { type Predicate } from "./table-api.ts";
import type { DocumentData } from "./json.ts";

// `Ticket` is a `type` intersection with `DocumentData` so it satisfies the
// current `T extends DocumentData` constraint on `Predicate<T>`.  Task 2 will
// remove that constraint; at that point the intersection becomes a no-op and
// the positive cases still compile, while the negative cases still fail.
type Ticket = DocumentData & {
  _id: string;
  status: "open" | "closed";
  count: number;
  assignee: { team: string; name: string };
  tags: string[];
};

// --- Positive cases — must typecheck ----------------------------

export const _topLevelKey: Predicate<Ticket> = { status: "open" };

export const _topLevelOperator: Predicate<Ticket> = { count: { $gte: 1 } };

export const _dottedKey: Predicate<Ticket> = {
  "assignee.team": "platform",
};

export const _arrayLeafValue: Predicate<Ticket> = { tags: ["x"] };

// --- Negative cases — each property line must fail typecheck ----

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

export const _wrongOperatorValueType: Predicate<Ticket> = {
  // @ts-expect-error — count is number; $gte expects number
  count: { $gte: "1" },
};

export const _noArrayIndexing: Predicate<Ticket> = {
  // @ts-expect-error — tags is a leaf (array); no "tags.0" path
  "tags.0": "x",
};

// --- Depth-cap boundary ---------------------------------------

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
