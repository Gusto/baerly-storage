import { BaerlyError, type Db } from "@gusto/baerly-storage";
import type { Verdict } from "../../types.ts";

type InsertOnce = (col: unknown, doc: { _id: string }) => Promise<string>;

/** A collection whose first insert throws `thrown`; `landed` says whether `get` finds the row. */
function fake(landed: boolean, thrown: Error) {
  const log: string[] = [];
  let first = true;
  const col = {
    insert: async (d: { _id: string }) => {
      log.push("insert");
      if (first) {
        first = false;
        throw thrown;
      }
      return { _id: d._id };
    },
    get: async (id: string) => {
      log.push("get");
      return landed ? { _id: id } : undefined;
    },
  };
  return { col, log };
}

const ambiguous = () => new BaerlyError("AmbiguousCommit", "unknown", { _id: "t-1" });

// The solution path arrives as `--solution=<abs>` in process.argv.
export async function check(_db: Db, _result: unknown): Promise<Verdict> {
  const arg = process.argv.find((a) => a.startsWith("--solution="))!;
  const { insertOnce } = (await import(arg.slice("--solution=".length))) as {
    insertOnce: InsertOnce;
  };
  const landed = fake(true, ambiguous());
  const r1 = await insertOnce(landed.col, { _id: "t-1" });
  if (r1 !== "t-1" || landed.log.join() !== "insert,get") {
    return { pass: false, reason: `landed case: ${r1} ${landed.log.join()}` };
  }
  const lost = fake(false, ambiguous());
  const r2 = await insertOnce(lost.col, { _id: "t-1" });
  if (r2 !== "t-1" || lost.log.join() !== "insert,get,insert") {
    return { pass: false, reason: `lost case: ${r2} ${lost.log.join()}` };
  }
  const other = fake(false, new BaerlyError("AlreadyExists", "dup"));
  const err = await insertOnce(other.col, { _id: "t-1" }).then(
    () => null,
    (error: unknown) => error,
  );
  if (
    !(err instanceof BaerlyError) ||
    err.code !== "AlreadyExists" ||
    other.log.join() !== "insert"
  ) {
    return { pass: false, reason: `other error must rethrow untouched: ${other.log.join()}` };
  }
  return { pass: true, reason: "read-back before re-insert; other errors rethrown" };
}
