import { getCurrentContext } from "./observability/context.ts";

const UNSAFE_INTEGER_RESOLUTION =
  "Store 64-bit ids and other integers above 2^53 as strings: a JSON number that large is rounded before it is stored.";

/**
 * The unsafe-integer reporting for one write. `onUnsafeInteger` is the
 * validation hook of `assertDocumentValues`: it only records the first
 * offending field path, so it cannot throw inside the caller-facing
 * validation. `report` is called once the write has committed: it counts
 * the write on `db.write.unsafe_integer_total` (labelled by `collection`
 * and `verb`) and emits an `unsafe_integer` structured warning naming the
 * path. A refused write, or an SDK retry of one, is never reported.
 * Nothing is refused. The warning goes through the adapter's
 * `maintenance.warn` sink when one is bound, else to `console.warn`, so
 * the kernel never imports LogTape.
 */
export const unsafeIntegerReport = (
  collection: string,
  verb: string,
): { readonly onUnsafeInteger: (path: string) => void; readonly report: () => void } => {
  let found: string | undefined;
  return {
    onUnsafeInteger: (path) => {
      found = path;
    },
    report: () => {
      if (found === undefined) {
        return;
      }
      const path = found;
      const context = getCurrentContext();
      try {
        context?.recorder.counter("db.write.unsafe_integer_total", 1, { collection, verb });
      } catch {
        // A recorder fault must not fail a write that already committed.
      }
      const detail = `${verb}: the number at ${path === "" ? "the document root" : path} is an integer outside the safe range (beyond 2^53), so it was probably rounded before it reached the database. ${UNSAFE_INTEGER_RESOLUTION}`;
      const sink = context?.maintenance?.warn;
      if (sink !== undefined) {
        try {
          sink("unsafe_integer", { collection, verb, path, detail });
          return;
        } catch {
          // Fall through to the console line.
        }
      }
      console.warn(detail);
    },
  };
};
