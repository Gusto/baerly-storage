import {
  MemoryStorage,
  GC_GRACE_PERIOD_MILLIS,
  casUpdateCurrentJson,
  createCurrentJson,
  createGcPending,
  readGcPending,
  type GcPending,
  type Storage,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { logStateCurrentJson } from "../../../tests/fixtures/log-state.ts";
import { runGc, type InternalRunGcOptions } from "./gc.ts";

const PREFIX = "app/t/tenant/x/manifests/c";
const CURRENT = `${PREFIX}/current.json`;
const PENDING = `${PREFIX}/gc/pending.json`;
const GENERATION = "0123456789ab";
const START = Date.parse("2026-01-01T00:00:00.000Z");
const key = (seq: number) =>
  `${PREFIX}/snapshot/L9/000000000000-${String(seq).padStart(12, "0")}-${"a".repeat(64)}.json`;
const options = (clock: number, maxSweeps = 10): InternalRunGcOptions => ({
  now: () => new Date(clock),
  maxMarksPerRun: 10,
  maxSweepsPerRun: maxSweeps,
});
const checkpoint = (dueAt = START): NonNullable<GcPending["snapshot_gc"]> => ({
  eligible_floor: 0,
  pending_floor: 100,
  due_at: new Date(dueAt).toISOString(),
  generation: GENERATION,
});
const seed = async (snapshotGc: GcPending["snapshot_gc"], candidateSeqs: number[] = [10]) => {
  const storage = new MemoryStorage();
  await createCurrentJson(
    storage,
    CURRENT,
    logStateCurrentJson({ log_seq_start: 100, tail_hint: 100 }),
  );
  for (const seq of candidateSeqs) {
    await storage.put(key(seq), new Uint8Array([1]));
  }
  await createGcPending(storage, PENDING, {
    schema_version: 1,
    last_swept_at: "",
    candidates: candidateSeqs.map((seq) => ({
      key: key(seq),
      reason: "orphan-snapshot",
      generation: GENERATION,
      due_at: new Date(START + GC_GRACE_PERIOD_MILLIS).toISOString(),
    })),
    ...(snapshotGc !== undefined && { snapshot_gc: snapshotGc }),
  });
  return storage;
};

describe("snapshot floor grace", () => {
  test("an aged floor reclaims known candidates without waiting for their newer individual marks", async () => {
    const storage = await seed(checkpoint());
    const result = await runGc({ storage, currentJsonKey: CURRENT }, options(START));
    expect(result.swept).toBe(1);
    await expect(storage.get(key(10))).resolves.toBeNull();
    const pending = await readGcPending(storage, PENDING);
    expect(pending?.json.snapshot_gc).toMatchObject({
      eligible_floor: 100,
      pending_floor: 100,
      due_at: new Date(START + GC_GRACE_PERIOD_MILLIS).toISOString(),
    });
  });

  test("a newly observed or not-yet-due floor earns a full grace", async () => {
    for (const snapshotGc of [undefined, checkpoint(START + 1)]) {
      const storage = await seed(snapshotGc);
      const result = await runGc({ storage, currentJsonKey: CURRENT }, options(START));
      expect(result.swept).toBe(0);
      await expect(storage.get(key(10))).resolves.not.toBeNull();
    }
  });

  test("floor equality and the fresh live pointer are never reclaimed", async () => {
    const storage = await seed(checkpoint(), [10, 100]);
    await casUpdateCurrentJson(storage, CURRENT, (latest) => ({ ...latest, snapshot: key(10) }));
    const result = await runGc({ storage, currentJsonKey: CURRENT }, options(START));
    expect(result.swept).toBe(0);
    await expect(storage.get(key(10))).resolves.not.toBeNull();
    await expect(storage.get(key(100))).resolves.not.toBeNull();
  });

  test("a lowered floor restarts grace even if its generation was reused", async () => {
    const storage = await seed({ ...checkpoint(), eligible_floor: 150, pending_floor: 200 });
    const result = await runGc({ storage, currentJsonKey: CURRENT }, options(START));
    expect(result.swept).toBe(0);
    await expect(storage.get(key(10))).resolves.not.toBeNull();
    const pending = await readGcPending(storage, PENDING);
    expect(pending?.json.snapshot_gc).toMatchObject({
      eligible_floor: 0,
      pending_floor: 100,
      due_at: new Date(START + GC_GRACE_PERIOD_MILLIS).toISOString(),
    });
  });

  test("a pointer published after LIST is rescued by the fresh manifest read", async () => {
    const inner = await seed(checkpoint());
    let currentGets = 0;
    const storage: Storage = {
      get: async (objectKey, opts) => {
        if (objectKey === CURRENT && ++currentGets === 2) {
          await casUpdateCurrentJson(inner, CURRENT, (latest) => ({
            ...latest,
            snapshot: key(10),
          }));
        }
        return inner.get(objectKey, opts);
      },
      put: (...args) => inner.put(...args),
      delete: (...args) => inner.delete(...args),
      list: (...args) => inner.list(...args),
    };
    const result = await runGc({ storage, currentJsonKey: CURRENT }, options(START));
    expect(result.swept).toBe(0);
    await expect(inner.get(key(10))).resolves.not.toBeNull();
  });

  test("fresh generation changes fence a floor that matured under the initial manifest", async () => {
    const inner = await seed(checkpoint());
    let currentGets = 0;
    const storage: Storage = {
      ...inner,
      get: async (objectKey, opts) => {
        if (objectKey === CURRENT && ++currentGets === 2) {
          await casUpdateCurrentJson(inner, CURRENT, (latest) => ({
            ...latest,
            generation: "abcdef012345",
          }));
        }
        return inner.get(objectKey, opts);
      },
      put: (...args) => inner.put(...args),
      delete: (...args) => inner.delete(...args),
      list: (...args) => inner.list(...args),
    };
    const result = await runGc({ storage, currentJsonKey: CURRENT }, options(START));
    expect(result.swept).toBe(0);
    await expect(inner.get(key(10))).resolves.not.toBeNull();
    const pending = await readGcPending(inner, PENDING);
    expect(pending?.json.snapshot_gc).toMatchObject({
      eligible_floor: 0,
      generation: "abcdef012345",
    });
  });

  test("old-generation checkpoint evidence cannot accelerate a current-generation mark", async () => {
    const storage = await seed({ ...checkpoint(), generation: "abcdef012345" });
    const result = await runGc({ storage, currentJsonKey: CURRENT }, options(START));
    expect(result.swept).toBe(0);
    await expect(storage.get(key(10))).resolves.not.toBeNull();
  });

  test("range eligibility honors the sweep cap", async () => {
    const storage = await seed(checkpoint(), [10, 11, 12]);
    const result = await runGc({ storage, currentJsonKey: CURRENT }, options(START, 1));
    expect(result.swept).toBe(1);
    const pending = await readGcPending(storage, PENDING);
    expect(pending?.json.candidates).toHaveLength(2);
  });

  test("a concurrent checkpoint cannot attach an older due time to a newer floor", async () => {
    const inner = await seed(checkpoint(START + 1));
    await casUpdateCurrentJson(inner, CURRENT, (latest) => ({
      ...latest,
      log_seq_start: 200,
      tail_hint: 200,
    }));
    let pendingGets = 0;
    const newer = { ...checkpoint(START + GC_GRACE_PERIOD_MILLIS), pending_floor: 200 };
    const storage: Storage = {
      get: async (objectKey, opts) => {
        if (objectKey === PENDING && ++pendingGets === 2) {
          const current = await readGcPending(inner, PENDING);
          await inner.put(
            PENDING,
            new TextEncoder().encode(JSON.stringify({ ...current!.json, snapshot_gc: newer })),
          );
        }
        return inner.get(objectKey, opts);
      },
      put: (...args) => inner.put(...args),
      delete: (...args) => inner.delete(...args),
      list: (...args) => inner.list(...args),
    };
    await runGc({ storage, currentJsonKey: CURRENT }, options(START));
    const pending = await readGcPending(inner, PENDING);
    expect(pending?.json.snapshot_gc).toEqual(newer);
  });

  test("a stale pass preserves another generation's concurrently installed checkpoint", async () => {
    const inner = await seed(checkpoint(START + 1));
    let pendingGets = 0;
    const replacement = {
      ...checkpoint(START + GC_GRACE_PERIOD_MILLIS),
      generation: "abcdef012345",
    };
    const storage: Storage = {
      get: async (objectKey, opts) => {
        if (objectKey === PENDING && ++pendingGets === 2) {
          const current = await readGcPending(inner, PENDING);
          await inner.put(
            PENDING,
            new TextEncoder().encode(
              JSON.stringify({ ...current!.json, snapshot_gc: replacement }),
            ),
          );
        }
        return inner.get(objectKey, opts);
      },
      put: (...args) => inner.put(...args),
      delete: (...args) => inner.delete(...args),
      list: (...args) => inner.list(...args),
    };
    await runGc({ storage, currentJsonKey: CURRENT }, options(START));
    const pending = await readGcPending(inner, PENDING);
    expect(pending?.json.snapshot_gc).toEqual(replacement);
  });

  test.each([
    { ...checkpoint(), eligible_floor: -1 },
    { ...checkpoint(), pending_floor: 0.5 },
    { ...checkpoint(), eligible_floor: 101 },
    { ...checkpoint(), due_at: "invalid" },
  ])("invalid checkpoint is refused before it can authorize deletion: %j", async (snapshotGc) => {
    await expect(seed(snapshotGc)).rejects.toMatchObject({ code: "InvalidResponse" });
  });
});
