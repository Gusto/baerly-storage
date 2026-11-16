/**
 * Type-level assertions for the row `_id` contract on `Collection<T>`:
 * every row a read returns carries `_id: string`, and `insert` takes an
 * optional string `_id`. Holds for unbound collections (row type
 * `DocumentData`), bound-config collections, and user row interfaces.
 *
 * Validated by `tsgo --noEmit` (via `pnpm verify`). Not picked up by
 * vitest — the `.test-d.ts` extension is outside the default include
 * glob (see `vitest.config.ts`).
 */

import {
  type Collection,
  defineConfig,
  type DocumentData,
  type SchemaValidator,
  type Storage,
} from "@baerly/protocol";
import { Db } from "./db.ts";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

declare const storage: Storage;

// --- Unbound: no config, row type `DocumentData` ------------------

const db = Db.create({ storage, app: "a", tenant: "t" });
const notes = db.collection("notes");

const unboundRows = await notes.all();
const unboundFirst = await notes.first();
const unboundGot = await notes.get("n-1");
const unboundQueried = await notes.where({ done: false }).limit(5).all();

export type _UnboundAllIdIsString = Expect<Equal<(typeof unboundRows)[number]["_id"], string>>;
export type _UnboundFirstIdIsString = Expect<
  Equal<NonNullable<typeof unboundFirst>["_id"], string>
>;
export type _UnboundGetIdIsString = Expect<Equal<NonNullable<typeof unboundGot>["_id"], string>>;
export type _UnboundQueryIdIsString = Expect<Equal<(typeof unboundQueried)[number]["_id"], string>>;

// A row's `_id` feeds the by-id verbs with no narrowing or cast.
export const _unboundRowIdFeedsByIdVerbs = async () => {
  for (const row of await notes.all()) {
    await notes.delete(row._id);
  }
  const row = await notes.first();
  if (row !== undefined) {
    await notes.get(row._id);
    await notes.update(row._id, { done: true });
    await notes.replace(row._id, { ...row, done: true });
  }
};

export const _unboundInsertIdMustBeAString = async () => {
  await notes.insert({ title: "minted" });
  await notes.insert({ _id: "n-1", title: "supplied" });
  // @ts-expect-error — a supplied `_id` must be a string.
  await notes.insert({ _id: 42, title: "x" });
  // @ts-expect-error — a supplied `_id` must be a string.
  await notes.insert({ _id: { nested: "x" }, title: "x" });
};

// --- Bound config: row type from the schema output ----------------

type TicketShape = { _id: string; title: string; status: "open" | "closed" };
const ticketSchema = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value: value as TicketShape }),
  },
} as const satisfies SchemaValidator<unknown, TicketShape>;

const config = defineConfig({
  collections: { tickets: { schema: ticketSchema }, audits: {} },
});
const boundDb = Db.create({ storage, app: "a", tenant: "t", config });
const tickets = boundDb.collection("tickets");
const audits = boundDb.collection("audits");

const ticketRows = await tickets.all();
const auditRow = await audits.first();
export type _BoundIdIsString = Expect<Equal<(typeof ticketRows)[number]["_id"], string>>;
export type _BoundKeepsSchemaFields = Expect<
  Equal<(typeof ticketRows)[number]["status"], "open" | "closed">
>;
export type _BoundNoSchemaIdIsString = Expect<Equal<NonNullable<typeof auditRow>["_id"], string>>;

export const _boundRowIdFeedsByIdVerbs = async () => {
  const row = await tickets.where({ status: "open" }).first();
  if (row !== undefined) {
    await tickets.replace(row._id, { ...row, status: "closed" });
    await tickets.delete(row._id);
  }
};

export const _boundInsertIdMustBeAString = async () => {
  await tickets.insert({ title: "t", status: "open" });
  // @ts-expect-error — a supplied `_id` must be a string.
  await tickets.insert({ _id: 7, title: "t", status: "open" });
};

// --- User row interface that already declares `_id: string` -------

interface Bookmark extends DocumentData {
  _id: string;
  url: string;
}
const bookmarks = db.collection("bookmarks") as Collection<Bookmark>;
const bookmark = await bookmarks.get("b-1");
export type _InterfaceRowKeepsFields = Expect<Equal<NonNullable<typeof bookmark>["url"], string>>;
export type _InterfaceRowIdIsString = Expect<Equal<NonNullable<typeof bookmark>["_id"], string>>;

export const _interfaceRowIsAssignableToT = async () => {
  const rows: Bookmark[] = await bookmarks.all();
  const first = rows[0];
  if (first !== undefined) {
    await bookmarks.replace(first._id, first);
  }
};

// A row type whose `_id` is optional still reads back `_id: string`.
type Draft = DocumentData & { _id?: string; body: string };
const drafts = db.collection("drafts") as Collection<Draft>;
const draft = await drafts.first();
export type _OptionalIdRowReadsString = Expect<Equal<NonNullable<typeof draft>["_id"], string>>;
