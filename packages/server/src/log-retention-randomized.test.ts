import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import {
  certifiedDeleteFloor,
  logDeleteFloorOf,
  logObjectKey,
  logSeqStartOf,
  MemoryStorage,
  readCurrentJson,
} from "@baerly/protocol";
import {
  applyOps,
  CURRENT_JSON_KEY,
  type Doc,
  LOG_PREFIX,
  opArb,
  PROP_TIMEOUT_MS,
  reconstructView,
  seedCurrentJson,
} from "./_internal/randomized-model.ts";
import { compact } from "./compactor.ts";
import { retireLogRange } from "./log-retention.ts";
import { createObservabilityContext, runWithContext } from "./observability/context.ts";
import { Writer } from "./writer.ts";

const ROUNDS = 3;
// Small enough that a 1-20-op round's worth of commits plausibly clears it —
// the repo default (`LOG_RETENTION_SEQ_WINDOW`, 1024) never would at this
// scale, which would make the non-vacuity assertion below silently vacuous.
const WINDOW = 5;
const MAX_DELETES = 1000;

describe("retireLogRange — never deletes a live object", () => {
  fcTest.prop({
    rounds: fc.array(fc.array(opArb, { minLength: 1, maxLength: 20 }), {
      minLength: ROUNDS,
      maxLength: ROUNDS,
    }),
  })(
    "across repeated write→compact→retire ticks: reader view unchanged, live log entries survive, and log_delete_floor never outruns log_seq_start",
    async ({ rounds }) => {
      const storage = new MemoryStorage();
      await seedCurrentJson(storage);
      const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY, options: {} });
      const model = new Map<string, Doc>();

      for (const ops of rounds) {
        // Disable in-band write-tick maintenance for the write+compact phase.
        // The write tick retires logs too (`maintenance.ts` Step 5), so
        // leaving it on would let uncontrolled background retirement happen
        // before the explicit sweep below, making the before/after comparison
        // meaningless.
        await runWithContext(
          createObservabilityContext({ maintenance: { disabled: true } }),
          async () => {
            await applyOps(writer, model, ops);
            await compact(
              { storage, currentJsonKey: CURRENT_JSON_KEY },
              { minEntriesToCompact: 1 },
            );
          },
        );

        const preRetire = await readCurrentJson(storage, CURRENT_JSON_KEY);
        if (preRetire === null) {
          throw new Error("current.json missing before retire");
        }
        const preLiveFloor = logSeqStartOf(preRetire.json);
        const preDeleteFloor = certifiedDeleteFloor(preRetire.json);
        const viewBefore = await reconstructView(storage);

        const result = await retireLogRange(storage, CURRENT_JSON_KEY, {
          window: WINDOW,
          maxDeletes: MAX_DELETES,
        });

        // (1) Reader view is unchanged, and matches the model.
        const viewAfter = await reconstructView(storage);
        expect(viewAfter).toEqual(viewBefore);
        expect(viewBefore).toEqual(Object.fromEntries(model));

        const postRetire = await readCurrentJson(storage, CURRENT_JSON_KEY);
        if (postRetire === null) {
          throw new Error("current.json missing after retire");
        }

        // (2) Nothing at or above the certified delete floor was deleted.
        const postDeleteFloor = logDeleteFloorOf(postRetire.json);
        for (let seq = postDeleteFloor; seq < postRetire.json.tail_hint; seq++) {
          await expect(
            storage.get(logObjectKey(LOG_PREFIX, seq)),
            `live log seq ${String(seq)} must survive retireLogRange`,
          ).resolves.not.toBeNull();
        }

        // (3) Invariant 12: log_delete_floor never outruns log_seq_start.
        expect(postDeleteFloor).toBeLessThanOrEqual(logSeqStartOf(postRetire.json));

        // (4) Non-vacuity: whenever the pre-retire state authorized a
        // non-empty range under this window, the sweep must have actually
        // deleted something — don't just hope the shrinker stumbles into it.
        if (preLiveFloor - preDeleteFloor > WINDOW) {
          expect(result.deleted).toBeGreaterThan(0);
        }
      }
    },
    PROP_TIMEOUT_MS,
  );
});
