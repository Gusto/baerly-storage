import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { type DocumentData, MemoryStorage } from "@baerly/protocol";
import {
  applyOps,
  CURRENT_JSON_KEY,
  type Doc,
  LOG_PREFIX,
  opArb,
  PROP_TIMEOUT_MS,
  seedCurrentJson,
} from "./_internal/randomized-model.ts";
import { compact } from "./compactor.ts";
import { Writer } from "./writer.ts";
import { replayLiveDocs } from "../../../tests/fixtures/replay-live-docs.ts";

const asObj = (m: Map<string, DocumentData>): Record<string, DocumentData> => Object.fromEntries(m);

describe("compact — materialized view is unchanged by compaction", () => {
  test.prop({ ops: fc.array(opArb, { minLength: 0, maxLength: 40 }) })(
    "post-compaction reader view == model live set; second run is a no-op",
    async ({ ops }) => {
      const storage = new MemoryStorage();
      await seedCurrentJson(storage);
      const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY, options: {} });

      const model = new Map<string, Doc>();
      await applyOps(writer, model, ops);

      // View BEFORE compaction must already equal the model (sanity anchor).
      expect(asObj(await replayLiveDocs(storage, LOG_PREFIX))).toEqual(asObj(model));

      // Compact everything available (minEntriesToCompact:1 so even 1 entry folds).
      const res = await compact(
        { storage, currentJsonKey: CURRENT_JSON_KEY },
        { minEntriesToCompact: 1 },
      );

      // The reader view AFTER compaction is byte-for-byte the same doc set.
      expect(asObj(await replayLiveDocs(storage, LOG_PREFIX))).toEqual(asObj(model));

      // Idempotence: if the first run folded the whole tail, a second run has
      // nothing left and reports below-min-threshold; the view stays put.
      if (res.written) {
        const second = await compact(
          { storage, currentJsonKey: CURRENT_JSON_KEY },
          { minEntriesToCompact: 1 },
        );
        expect(second.written).toBe(false);
        expect(asObj(await replayLiveDocs(storage, LOG_PREFIX))).toEqual(asObj(model));
      }
    },
    PROP_TIMEOUT_MS,
  );
});
