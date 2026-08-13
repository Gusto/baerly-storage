import {
  type BaerlyConfig,
  BaerlyError,
  type CurrentJson,
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  MemoryStorage,
  type SchemaValidator,
  type Storage,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { logStateCurrentJson } from "../../../tests/fixtures/log-state.ts";
import { Db } from "./db.ts";
import { createObservabilityContext, runWithContext } from "./observability/index.ts";

/**
 * Zero-state manifest for the log-read seams. `log_seq_start: 0` floors
 * nothing, so tests that assert on some *other* guard (path-segment
 * validation) pass it and stay unaffected by the floor.
 *
 * Routed through the shared factory rather than hand-written, so the
 * next `CurrentJson` field lands in one place instead of two.
 */
const FLOOR_ZERO: CurrentJson = logStateCurrentJson();

describe("Db.create", () => {
  test("returns a Db scoped to the given app and tenant", () => {
    const storage = new MemoryStorage();
    const db = Db.create({ storage, app: "tickets", tenant: "acme" });
    expect(db.app).toBe("tickets");
    expect(db.tenant).toBe("acme");
  });

  test("rejects empty app with BaerlyError{InvalidConfig}", () => {
    const storage = new MemoryStorage();
    expect(() => Db.create({ storage, app: "", tenant: "acme" })).toThrow(BaerlyError);
    try {
      Db.create({ storage, app: "", tenant: "acme" });
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test("rejects empty tenant with BaerlyError{InvalidConfig}", () => {
    const storage = new MemoryStorage();
    expect(() => Db.create({ storage, app: "x", tenant: "" })).toThrow(BaerlyError);
    try {
      Db.create({ storage, app: "x", tenant: "" });
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test('rejects "/" in app or tenant with BaerlyError{InvalidConfig}', () => {
    const storage = new MemoryStorage();
    expect(() => Db.create({ storage, app: "a/b", tenant: "t" })).toThrow(BaerlyError);
    expect(() => Db.create({ storage, app: "a", tenant: "t/u" })).toThrow(BaerlyError);
    try {
      Db.create({ storage, app: "a/b", tenant: "t" });
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test("collection names cannot start with the reserved _ prefix", () => {
    const db = Db.create({ storage: new MemoryStorage(), app: "a", tenant: "t" });
    expect(() => db.collection("_v2")).toThrow(/reserved for system use/);
    try {
      db.collection("_v2");
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
    expect(() => db.collection("notes")).not.toThrow();
  });

  test.each(["..", ".", "a/b", "with\u0000null", "x".repeat(257)])(
    "db.collection(%j) is rejected InvalidConfig",
    (bad) => {
      const db = Db.create({ storage: new MemoryStorage(), app: "a", tenant: "t" });
      expect(() => db.collection(bad)).toThrow(BaerlyError);
      try {
        db.collection(bad);
      } catch (error) {
        expect((error as BaerlyError).code).toBe("InvalidConfig");
      }
    },
  );

  test.each(["..", "with\u0000null"])(
    "db.getCurrentJson(%j) rejects InvalidConfig (no unvalidated traversal)",
    async (bad) => {
      const db = Db.create({ storage: new MemoryStorage(), app: "a", tenant: "t" });
      await expect(db.getCurrentJson(bad)).rejects.toMatchObject({ code: "InvalidConfig" });
    },
  );

  test.each(["..", "with\u0000null"])(
    "db.getLogEntry(%j) rejects InvalidConfig (no unvalidated traversal)",
    async (bad) => {
      const db = Db.create({ storage: new MemoryStorage(), app: "a", tenant: "t" });
      await expect(db.getLogEntry(bad, 0, FLOOR_ZERO)).rejects.toMatchObject({
        code: "InvalidConfig",
      });
    },
  );

  test("app names cannot start with the reserved _ prefix", () => {
    try {
      Db.create({ storage: new MemoryStorage(), app: "_x", tenant: "t" });
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
    expect(() => Db.create({ storage: new MemoryStorage(), app: "_x", tenant: "t" })).toThrow(
      /reserved for system use/,
    );
  });
});

describe("Db.create config derivation", () => {
  // Regression: `config` used to be a type-only seam. App and test
  // code that wrote `Db.create({ storage, app, tenant, config })`
  // silently dropped schemas + indexes at runtime; callers had to
  // discover `collectionsToMaps(config.collections)` and thread the
  // flattened maps explicitly. The fix derives the maps inside
  // `Db.create` when explicit `schemas` / `indexes` aren't passed.
  const onlyStrings: SchemaValidator = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => {
        if (typeof value === "object" && value !== null && "title" in value) {
          const t = (value as { title: unknown }).title;
          if (typeof t === "string") {
            return { value };
          }
        }
        return { issues: [{ path: ["title"], message: "title must be a string" }] };
      },
    },
  };

  test("derives schemas from config — invalid insert throws SchemaError", async () => {
    const config: BaerlyConfig = {
      collections: { tickets: { schema: onlyStrings } },
    };
    const db = Db.create({ storage: new MemoryStorage(), app: "x", tenant: "y", config });
    await expect(db.collection("tickets").insert({ title: 42 })).rejects.toMatchObject({
      code: "SchemaError",
    });
    // Valid insert still goes through — proves the schema was wired
    // (not just thrown blindly).
    await expect(db.collection("tickets").insert({ title: "ok" })).resolves.toBeDefined();
  });

  test("derives indexes from config — visible on the collectionReadContext", () => {
    const config: BaerlyConfig = {
      collections: { tickets: { indexes: [{ name: "by_status", on: "status" }] } },
    };
    const db = Db.create({ storage: new MemoryStorage(), app: "x", tenant: "y", config });
    expect(db.collectionReadContext("tickets").indexes.map((i) => i.name)).toEqual(["by_status"]);
  });
});

describe("Db → per-request metrics emission", () => {
  const APP = "tickets";
  const TENANT = "acme";
  const TABLE = "tickets";
  const currentJsonKey = `app/${APP}/tenant/${TENANT}/manifests/${TABLE}/current.json`;

  const provision = async (storage: Storage): Promise<void> => {
    await createCurrentJson(storage, currentJsonKey, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      tail_hint: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
  };

  test("single-mutation insert emits to the active context's recorder", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    const ctx = createObservabilityContext();
    const db = Db.create({ storage, app: APP, tenant: TENANT });
    await runWithContext(ctx, async () => {
      await db.collection(TABLE).insert({ title: "hi" });
    });
    // writer.ts emits one histogram observation per successful
    // commit via getCurrentContext()?.recorder. Outside any context,
    // observations route through the noop default.
    const observed = ctx.recorder
      .snapshot()
      .histograms.filter((h) => h.name === "db.write.class_a_ops_per_logical_write");
    expect(observed.length).toBeGreaterThan(0);
  });

  test("sequential commits each emit to the active context's recorder", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    const ctx = createObservabilityContext();
    const db = Db.create({ storage, app: APP, tenant: TENANT });
    await runWithContext(ctx, async () => {
      await db.collection(TABLE).insert({ title: "one" });
      await db.collection(TABLE).insert({ title: "two" });
    });
    const observed = ctx.recorder
      .snapshot()
      .histograms.filter((h) => h.name === "db.write.class_a_ops_per_logical_write");
    // The histogram is emitted once per commit, so two inserts produce
    // at least two observations.
    expect(observed.length).toBeGreaterThanOrEqual(2);
  });

  test("outside any context emissions are a no-op (no throw)", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    const db = Db.create({ storage, app: APP, tenant: TENANT });
    await expect(db.collection(TABLE).insert({ title: "hi" })).resolves.toBeDefined();
  });
});

// Required pin 2 of the log-retention safety contract: the two log-read
// seams on the public `Db` are floored at `log_seq_start`. Before this,
// `getLogEntry` took an arbitrary `seq` with no floor of any kind and
// `probeLogTail` an unvalidated `hint`; the only production caller
// (`http/since.ts`) floored correctly, but the floor lived entirely in
// that caller. Nothing in the type or a test stopped a future HTTP
// route, CDC path, or adapter from reading below the floor — which is
// exactly the range arithmetic log retention will reclaim.
describe("Db log-read seams are floored at log_seq_start", () => {
  const APP = "tickets";
  const TENANT = "acme";
  const TABLE = "tickets";

  /**
   * A provisioned collection holding `count` committed entries at
   * `log/0` … `log/<count-1>`. Commits never advance `log_seq_start`,
   * so the returned manifest always has floor 0 — raise it with
   * {@link raiseFloor}.
   */
  const seedEntries = async (count = 1): Promise<{ db: Db; current: CurrentJson }> => {
    const storage = new MemoryStorage();
    await createCurrentJson(
      storage,
      `app/${APP}/tenant/${TENANT}/manifests/${TABLE}/current.json`,
      FLOOR_ZERO,
    );
    const db = Db.create({ storage, app: APP, tenant: TENANT });
    for (let i = 0; i < count; i++) {
      await db.collection(TABLE).insert({ title: `row ${i}` });
    }
    const read = await db.getCurrentJson(TABLE);
    if (read === null) {
      throw new Error("test setup: current.json missing after insert");
    }
    return { db, current: read.json };
  };

  /**
   * The same manifest with the fold floor raised. `tail_hint` moves with
   * it because `0 <= log_seq_start <= tail_hint` is a documented
   * `CurrentJson` invariant and these literals never pass through
   * `assertCurrentJson`, so nothing else would catch an impossible one.
   */
  const raiseFloor = (current: CurrentJson, to: number): CurrentJson => ({
    ...current,
    log_seq_start: to,
    tail_hint: Math.max(current.tail_hint, to),
  });

  test("getLogEntry reads an entry at the floor", async () => {
    const { db, current } = await seedEntries();
    await expect(db.getLogEntry(TABLE, 0, current)).resolves.toMatchObject({ op: "I", seq: 0 });
  });

  test("getLogEntry throws Internal below the floor", async () => {
    const { db, current } = await seedEntries();
    await expect(db.getLogEntry(TABLE, 0, raiseFloor(current, 5))).rejects.toMatchObject({
      code: "Internal",
    });
  });

  // The floor retention actually reclaims against is a NON-ZERO one, and
  // at floor 0 "at the floor" is indistinguishable from "not negative".
  // Two entries with the floor raised to 1 separate them: seq 1 is at a
  // real floor with a folded entry beneath it and must still read.
  test("getLogEntry reads an entry at a raised floor", async () => {
    const { db, current } = await seedEntries(2);
    await expect(db.getLogEntry(TABLE, 1, raiseFloor(current, 1))).resolves.toMatchObject({
      op: "I",
      seq: 1,
    });
  });

  // The guard is ordering-only, so a negative seq is rejected because it
  // sorts below a zero floor — NOT because the seam validates its input.
  // `NaN`, `Infinity`, and fractional seqs still pass (`NaN < 0` is
  // `false`) and resolve `null` off a `log/NaN.json` GET.
  test("getLogEntry throws Internal on a seq below a zero floor", async () => {
    const { db, current } = await seedEntries();
    await expect(db.getLogEntry(TABLE, -1, current)).rejects.toMatchObject({
      code: "Internal",
      // The FOLD-floor wording, not the certified-delete-floor one. An absent
      // `log_delete_floor` decodes to 0, so a negative seq sorts below it
      // arithmetically — but no deleted prefix is certified, and reporting
      // the nonexistent object as reclaimed would be a lie. Pinning the
      // message stops the certified-delete-floor arm swallowing this case.
      message: expect.stringContaining("below the fold floor log_seq_start=0"),
    });
  });

  test("collection validation precedes the floor check", async () => {
    const db = Db.create({ storage: new MemoryStorage(), app: APP, tenant: TENANT });
    // Both guards would fire. The path-segment guard is the security
    // boundary, so it must win — a traversal attempt is never
    // reclassified as an internal invariant violation.
    await expect(db.getLogEntry("..", 0, raiseFloor(FLOOR_ZERO, 5))).rejects.toMatchObject({
      code: "InvalidConfig",
    });
  });

  test("probeLogTail probes from the floor", async () => {
    const { db, current } = await seedEntries();
    await expect(db.probeLogTail(TABLE, 0, current)).resolves.toBe(1);
  });

  // Same reason as the raised-floor read above: the probe must still find
  // the true tail when it starts at a non-zero floor.
  test("probeLogTail probes from a raised floor", async () => {
    const { db, current } = await seedEntries(2);
    await expect(db.probeLogTail(TABLE, 1, raiseFloor(current, 1))).resolves.toBe(2);
  });

  test("probeLogTail throws Internal on a sub-floor hint", async () => {
    const { db, current } = await seedEntries();
    await expect(db.probeLogTail(TABLE, 0, raiseFloor(current, 5))).rejects.toMatchObject({
      code: "Internal",
    });
  });

  // Required pin 5. The fold floor says "folded, and MAY already be
  // reclaimed"; the certified delete floor says "DELETED, and is gone."
  // Both throw `Internal`, so only the message tells an operator reading
  // the throw which state applies — the reason these floors are separate.
  // `old_snapshot_threshold` was
  // removed from PostgreSQL in PG17 as dangerously broken while Oracle's
  // `ORA-01555` survives the identical trade: the lethal property was
  // silence, not the window.
  describe("and at the certified delete floor", () => {
    /** `current` with a stored `log_delete_floor`, set independently of the fold floor. */
    const withDeleteFloor = (current: CurrentJson, to: number): CurrentJson => ({
      ...current,
      log_delete_floor: to,
    });

    test("getLogEntry names the certified delete floor below it", async () => {
      const { db, current } = await seedEntries(4);
      const manifest = withDeleteFloor(raiseFloor(current, 3), 2);
      await expect(db.getLogEntry(TABLE, 1, manifest)).rejects.toMatchObject({
        code: "Internal",
        message: expect.stringContaining("below the certified delete floor 2"),
      });
    });

    test("probeLogTail names the certified delete floor below it", async () => {
      const { db, current } = await seedEntries(4);
      const manifest = withDeleteFloor(raiseFloor(current, 3), 2);
      await expect(db.probeLogTail(TABLE, 1, manifest)).rejects.toMatchObject({
        code: "Internal",
        message: expect.stringContaining("below the certified delete floor 2"),
      });
    });

    // A seq in the gap between the two floors is folded but not yet
    // deleted, and must keep the weaker "may already be reclaimed"
    // wording. This is what a MERGED single arm would break, and what
    // `Math.min` → `Math.max` would break; the two cases above are what
    // an arm appended AFTER the fold-floor check would break, since a
    // sub-delete-floor seq is also sub-fold-floor and would take the
    // first arm.
    test("a seq between the two floors keeps the fold-floor wording", async () => {
      const { db, current } = await seedEntries(4);
      const manifest = withDeleteFloor(raiseFloor(current, 3), 1);
      await expect(db.getLogEntry(TABLE, 2, manifest)).rejects.toMatchObject({
        code: "Internal",
        message: expect.stringContaining("below the fold floor log_seq_start=3"),
      });
    });

    // The effective floor is CLAMPED to `log_seq_start`. An out-of-bound
    // `log_delete_floor` is readable off disk on purpose — the
    // `<= log_seq_start` bound is transition-scoped, not enforced by the
    // single-state guard, so that a manifest in that state stays
    // repairable by `admin restore`. Unclamped, this seam would report an
    // entry that is demonstrably PRESENT as gone.
    test("clamps an out-of-bound delete floor to log_seq_start", async () => {
      const { db, current } = await seedEntries(2);
      const manifest = withDeleteFloor(raiseFloor(current, 1), 5);
      await expect(db.getLogEntry(TABLE, 1, manifest)).resolves.toMatchObject({
        op: "I",
        seq: 1,
      });
    });

    // When the clamp bites, the message must not attribute the clamped
    // value to the field. An operator debugging an out-of-bound floor is
    // the one reader who most needs the stored number, and "the manifest
    // says 5, I am using 3" is the whole diagnosis.
    test("reports the stored floor alongside the clamped one", async () => {
      const { db, current } = await seedEntries(4);
      const manifest = withDeleteFloor(raiseFloor(current, 3), 5);
      await expect(db.getLogEntry(TABLE, 1, manifest)).rejects.toMatchObject({
        code: "Internal",
        message: expect.stringContaining(
          "below the certified delete floor 3 (stored log_delete_floor=5, clamped to log_seq_start=3)",
        ),
      });
    });

    // A manifest that certifies no deleted prefix must never take this arm,
    // even for a seq that sorts below its zero delete floor.
    test("stays silent when no deleted prefix is certified", async () => {
      const { db, current } = await seedEntries(2);
      await expect(
        db.getLogEntry(TABLE, -1, withDeleteFloor(raiseFloor(current, 1), 0)),
      ).rejects.toMatchObject({
        code: "Internal",
        message: expect.stringContaining("below the fold floor log_seq_start=1"),
      });
    });
  });
});
