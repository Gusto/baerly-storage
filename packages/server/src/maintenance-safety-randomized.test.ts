import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { logDeleteFloorOf, logSeqStartOf, MemoryStorage, readCurrentJson } from "@baerly/protocol";
import {
  applyOps,
  COLLECTION,
  CURRENT_JSON_KEY,
  type Doc,
  LOG_PREFIX,
  opArb,
  PROP_TIMEOUT_MS,
  reconstructView,
  seedCurrentJson,
} from "./_internal/randomized-model.ts";
import { compact } from "./compactor.ts";
import type { InternalMaintenanceOptions } from "./maintenance-options.ts";
import { runScheduledMaintenance } from "./maintenance.ts";
import { createObservabilityContext, runWithContext } from "./observability/context.ts";
import { loadSnapshotAsMap } from "./snapshot.ts";
import { Writer } from "./writer.ts";

const ORPHAN_CONTENT_KEY = `${LOG_PREFIX}/content/${"f".repeat(32)}.json`;

// Internal-only seams (the public `MaintenanceOptions` cannot express
// either). `gc.graceMillis: 0` makes the GC slice's marks due in-pass
// rather than after the production 7-day grace; `logRetention.window: 0`
// erases the default sequence safety margin so a single retirement pass
// reaches the whole sub-floor prefix, and `maxDeletes: 64` covers the
// model's worst case (≤ 40 commits across both op batches) so the
// default per-tick budget of 20 cannot starve the non-vacuity
// assertion below. Neither seam runs in production.
const maintenanceOpts: InternalMaintenanceOptions = {
  gc: { graceMillis: 0 },
  logRetention: { window: 0, maxDeletes: 64 },
};

describe("runScheduledMaintenance — never deletes a live object", () => {
  test.prop({
    ops1: fc.array(opArb, { minLength: 1, maxLength: 20 }),
    ops2: fc.array(opArb, { minLength: 1, maxLength: 20 }),
  })(
    "after a pass: reader view unchanged, live objects survive, stale log reclaimed",
    async ({ ops1, ops2 }) => {
      const storage = new MemoryStorage();
      await seedCurrentJson(storage);
      const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY, options: {} });
      const model = new Map<string, Doc>();

      // Two write+compact rounds → stale logs AND (if both rounds folded)
      // an orphan snapshot from round 1.
      //
      // Disable the Writer's in-band write-tick maintenance for the seeding
      // phase. An opportunistic tick would run GC with the PRODUCTION
      // grace (7 days), pre-marking an orphan-snapshot candidate into
      // `gc/pending.json` with a 7-day-future `due_at`, and would run
      // retirement with the default 1024-seq window — either one would
      // perturb state the explicit pass below is supposed to own. With
      // maintenance disabled here, the explicit
      // `runScheduledMaintenance` call is the sole maintenance pass and
      // fully controls every mark, sweep, and retirement.
      await runWithContext(
        createObservabilityContext({ maintenance: { disabled: true } }),
        async () => {
          await applyOps(writer, model, ops1);
          await compact({ storage, currentJsonKey: CURRENT_JSON_KEY }, { minEntriesToCompact: 1 });
          await applyOps(writer, model, ops2);
          await compact({ storage, currentJsonKey: CURRENT_JSON_KEY }, { minEntriesToCompact: 1 });
        },
      );

      // Inject a legacy content key — the inertness witness.
      await storage.put(ORPHAN_CONTENT_KEY, new Uint8Array([1, 2, 3]), {
        contentType: "application/json",
      });

      // Capture live state + view BEFORE the pass.
      const read = await readCurrentJson(storage, CURRENT_JSON_KEY);
      if (read === null) {
        throw new Error("current.json missing before pass");
      }
      const logSeqStart = logSeqStartOf(read.json);
      const nextSeq = read.json.tail_hint;
      const liveSnapshotKey = read.json.snapshot;
      const viewBefore = await reconstructView(storage);

      // The pass: compact + GC + retirement, grace bypassed so GC marks
      // become due immediately and the retention window erased so
      // retirement reaches the whole certified-stale prefix.
      await runScheduledMaintenance({ storage, currentJsonKey: CURRENT_JSON_KEY }, maintenanceOpts);

      // (1) Reader view is byte-for-byte identical.
      const viewAfter = await reconstructView(storage);
      expect(viewAfter).toEqual(viewBefore);
      expect(viewBefore).toEqual(Object.fromEntries(model));

      // (2) Every live log entry still resolves. Retirement may only
      //     delete below `log_seq_start`; anything at or above it is
      //     live and must survive the pass.
      for (let s = logSeqStart; s < nextSeq; s++) {
        await expect(
          storage.get(`${LOG_PREFIX}/log/${s}.json`),
          `live log seq ${s} must survive maintenance`,
        ).resolves.not.toBeNull();
      }
      // (2) The current snapshot still loads (hash-checked).
      if (liveSnapshotKey !== null) {
        await expect(
          loadSnapshotAsMap(storage, liveSnapshotKey, COLLECTION),
        ).resolves.toBeInstanceOf(Map);
      }

      // (3) Non-vacuity, migrated to the retirement path: when there was
      //     a stale prefix to reclaim (`log_seq_start > 0` — at least one
      //     seeding fold landed), the pass must have certified and
      //     deleted it. With `window: 0` and a maxDeletes budget larger
      //     than any generated backlog, the floor lands exactly at the
      //     live floor; when nothing was folded there was nothing stale
      //     and the floor stays absent (reads as 0).
      await expect(
        storage.get(ORPHAN_CONTENT_KEY),
        "legacy content must be left in place",
      ).resolves.not.toBeNull();
      const after = await readCurrentJson(storage, CURRENT_JSON_KEY);
      if (after === null) {
        throw new Error("current.json missing after pass");
      }
      expect(logDeleteFloorOf(after.json)).toBe(logSeqStart);
      if (logSeqStart > 0) {
        await expect(
          storage.get(`${LOG_PREFIX}/log/0.json`),
          "stale log/0 must be retired",
        ).resolves.toBeNull();
      }
    },
    PROP_TIMEOUT_MS,
  );
});
