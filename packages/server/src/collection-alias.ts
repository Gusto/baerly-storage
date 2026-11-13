import { BaerlyError } from "@baerly/protocol";
import { markCallerFacing } from "./caller-facing-error.ts";

const ALIASED_COLLECTION_RESOLUTION =
  "An earlier release stored this collection under a non-NFC name, and this name addresses the same stored objects, so it cannot be read or written safely. Keep the app on a different NFC name: export the stored data with `baerly admin dump --collection=<stored name>` and restore it with `baerly admin restore` under an NFC name that is not canonically equivalent to either spelling.";

/**
 * `true` when a stored log entry, snapshot, or snapshot manifest that
 * names collection `stored` belongs to collection `expected`. Every
 * fold, compaction, capacity check, and export that filters stored
 * records by collection asks through this.
 *
 * R2 stores canonically-equivalent keys as one object, so an NFC name
 * addresses the objects a legacy non-NFC name wrote (and vice versa).
 * Those records carry the other spelling. Skipping them would read as an
 * empty collection and let a fold advance the floor past them, after
 * which log retirement deletes them, so a canonically-equivalent but
 * byte-different name throws instead of returning `false`.
 *
 * @throws BaerlyError code="InvalidConfig" — `stored` and `expected`
 *   differ but are canonically equivalent. Marked caller-facing.
 */
export const isOwnCollection = (stored: string, expected: string): boolean => {
  if (stored === expected) {
    return true;
  }
  if (typeof stored === "string" && stored.normalize("NFC") === expected.normalize("NFC")) {
    throw markCallerFacing(
      new BaerlyError(
        "InvalidConfig",
        `collection ${JSON.stringify(expected)} addresses data stored under the canonically-equivalent name ${JSON.stringify(stored)} (a different Unicode normalization); refusing to read or rewrite it`,
        { resolution: ALIASED_COLLECTION_RESOLUTION },
      ),
    );
  }
  return false;
};
