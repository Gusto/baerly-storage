import { describe, expect, test } from "vitest";
import {
  BaerlyError,
  createCurrentJson,
  encodeJsonBytes,
  MemoryStorage,
  readCurrentJson,
  sha256Hex,
} from "@baerly/protocol";
import { compact } from "@baerly/server/maintenance";
import { type InternalCompactOptions, Writer } from "@baerly/server/_internal/testing";
import { logStateCurrentJson } from "../fixtures/log-state.ts";
import {
  captureBucket,
  classifyKey,
  judgeStep,
  observeStep,
  type OracleStep,
  surfacedErrorViolation,
} from "../fixtures/physical-oracle.ts";

const PREFIX = "app/a/tenant/t/manifests/c";
const CURRENT = `${PREFIX}/current.json`;

/** A bucket with five committed rows folded into a published snapshot. */
const foldedBucket = async (): Promise<{ storage: MemoryStorage; snapshot: string }> => {
  const storage = new MemoryStorage();
  await createCurrentJson(
    storage,
    CURRENT,
    logStateCurrentJson({ writer_fence: { epoch: 0, owner: "oracle", claimed_at: "" } }),
  );
  const writer = new Writer({ storage, currentJsonKey: CURRENT });
  for (let i = 0; i < 5; i++) {
    await writer.commit({ op: "I", collection: "c", docId: `d-${i}`, body: { _id: `d-${i}` } });
  }
  await compact({ storage, currentJsonKey: CURRENT }, {
    minEntriesToCompact: 1,
    maxEntriesPerRun: 50,
  } as InternalCompactOptions);
  const snapshot = (await readCurrentJson(storage, CURRENT))!.json.snapshot!;
  return { storage, snapshot };
};

const judgeRun = (storage: MemoryStorage, step: OracleStep, run: () => Promise<unknown>) =>
  observeStep({ storage, collectionPrefix: PREFIX, step, run });

describe("physical oracle key classification", () => {
  test("parses the monolithic layout and rejects everything else", () => {
    const hash = "a".repeat(64);
    expect(classifyKey(PREFIX, `${PREFIX}/current.json`).cls).toBe("current");
    expect(classifyKey(PREFIX, `${PREFIX}/gc/pending.json`).cls).toBe("gc-pending");
    expect(classifyKey(PREFIX, `${PREFIX}/log/12.json`)).toEqual({ cls: "log", seq: 12 });
    expect(
      classifyKey(PREFIX, `${PREFIX}/snapshot/L9/000000000000-000000000007-${hash}.json`),
    ).toEqual({ cls: "snapshot", maxSeq: 7, sealed: hash });
    expect(classifyKey(PREFIX, `${PREFIX}/index/by_n/00/doc.json`).cls).toBe("legacy-index");
    expect(classifyKey(PREFIX, `${PREFIX}/content/0123abcd.json`).cls).toBe("legacy-content");
    for (const key of [
      `${PREFIX}/log/07.json`,
      `${PREFIX}/log/7.tmp`,
      `${PREFIX}/snapshot/L8/000000000000-000000000007-${hash}.json`,
      `${PREFIX}/_v2/snapshot/chunks/x/sha256/${hash}.json`,
      `app/a/tenant/t/manifests/other/current.json`,
    ]) {
      expect(classifyKey(PREFIX, key).cls).toBe("unknown");
    }
  });
});

describe("physical oracle catches broken steps", () => {
  test("a real fold passes and leaves no residue", async () => {
    const { storage } = await foldedBucket();
    const writer = new Writer({ storage, currentJsonKey: CURRENT });
    await writer.commit({ op: "I", collection: "c", docId: "x", body: { _id: "x" } });
    const observed = await judgeRun(storage, "compact", () =>
      compact({ storage, currentJsonKey: CURRENT }, {
        minEntriesToCompact: 1,
        maxEntriesPerRun: 50,
      } as InternalCompactOptions),
    );
    expect(observed.completed).toBe(true);
    expect(observed.violations).toEqual([]);
    // The replaced snapshot is an orphan until GC reclaims it.
    expect(observed.residue.orphanSnapshots).toHaveLength(1);
    expect(observed.residue.tornSnapshots).toEqual([]);
  });

  test("rewriting an immutable log entry is a violation", async () => {
    const { storage } = await foldedBucket();
    const observed = await judgeRun(storage, "write", () =>
      storage.put(`${PREFIX}/log/2.json`, encodeJsonBytes({ forged: true })),
    );
    expect(observed.violations).toEqual([
      `write rewrote an immutable log key: ${PREFIX}/log/2.json`,
    ]);
  });

  test("a step adding a class it does not own is a violation", async () => {
    const { storage } = await foldedBucket();
    const observed = await judgeRun(storage, "compact", () =>
      storage.put(`${PREFIX}/log/5.json`, encodeJsonBytes({})),
    );
    expect(observed.violations).toEqual([`compact added a log key: ${PREFIX}/log/5.json`]);
  });

  test("GC deleting the published snapshot is a violation", async () => {
    const { storage, snapshot } = await foldedBucket();
    const observed = await judgeRun(storage, "gc", () => storage.delete(snapshot));
    expect(observed.violations).toEqual([
      `gc removed the published snapshot: ${snapshot}`,
      `current.json publishes a missing snapshot: ${snapshot}`,
    ]);
  });

  test("retirement deleting log at or above log_delete_floor is a violation", async () => {
    const { storage } = await foldedBucket();
    // No floor is published, so every log entry is still protected.
    const observed = await judgeRun(storage, "retire", () =>
      storage.delete(`${PREFIX}/log/0.json`),
    );
    expect(observed.violations).toEqual([
      "retire removed log seq 0 at or above log_delete_floor 0",
    ]);
  });

  test("a published snapshot whose bytes miss their sealed digest is a violation", async () => {
    const { storage, snapshot } = await foldedBucket();
    const observed = await judgeRun(storage, "write", () =>
      storage.put(snapshot, encodeJsonBytes({ torn: true })),
    );
    expect(observed.violations).toEqual([
      `write rewrote an immutable snapshot key: ${snapshot}`,
      `current.json publishes a torn snapshot: ${snapshot}`,
    ]);
  });

  test("an unknown key layout is a violation", async () => {
    const { storage } = await foldedBucket();
    const observed = await judgeRun(storage, "compact", () =>
      storage.put(`${PREFIX}/snapshot/L9/half-written.tmp`, new Uint8Array([1])),
    );
    expect(observed.violations).toEqual([
      `unknown key layout: ${PREFIX}/snapshot/L9/half-written.tmp`,
    ]);
  });

  test("touching a legacy object is a violation for every step", async () => {
    const { storage } = await foldedBucket();
    const legacy = `${PREFIX}/index/by_n/00/doc.json`;
    await storage.put(legacy, new Uint8Array(0));
    for (const step of ["write", "compact", "gc", "retire"] as const) {
      const observed = await judgeRun(storage, step, async () => {
        await storage.put(legacy, new Uint8Array([step.length]));
      });
      expect(observed.violations).toEqual([
        `${step} rewrote an immutable legacy-index key: ${legacy}`,
      ]);
    }
    const removed = await judgeRun(storage, "gc", () => storage.delete(legacy));
    expect(removed.violations).toEqual([`gc removed a legacy-index key: ${legacy}`]);
  });

  test("residue: an unpublished torn snapshot and log leaked below the floor are reported, not violations", async () => {
    const { storage } = await foldedBucket();
    const sealed = await sha256Hex(encodeJsonBytes({ rows: [] }));
    const torn = `${PREFIX}/snapshot/L9/000000000000-000000000003-${sealed}.json`;
    const before = await captureBucket(storage, `${PREFIX}/`);
    await storage.put(torn, new Uint8Array([1, 2]));
    const after = await captureBucket(storage, `${PREFIX}/`);
    const manifest = (await readCurrentJson(storage, CURRENT))!.json;
    const verdict = judgeStep({
      collectionPrefix: PREFIX,
      step: "compact",
      before,
      after,
      afterManifest: { ...manifest, log_delete_floor: 2 },
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.residue.tornSnapshots).toEqual([torn]);
    expect(verdict.residue.leakedLog).toEqual([`${PREFIX}/log/0.json`, `${PREFIX}/log/1.json`]);
  });
});

describe("surfaced-error allow-list", () => {
  test("passes the injected abort and allow-listed codes", () => {
    const abort = Object.assign(new Error("x"), { name: "AbortError" });
    expect(surfacedErrorViolation("compact", abort)).toBeUndefined();
    expect(
      surfacedErrorViolation("compact", new BaerlyError("WriteConflict", "x")),
    ).toBeUndefined();
    expect(
      surfacedErrorViolation("write", new BaerlyError("AmbiguousCommit", "x")),
    ).toBeUndefined();
  });

  test("rejects a code outside the step's list and any non-BaerlyError", () => {
    expect(surfacedErrorViolation("compact", new BaerlyError("AmbiguousCommit", "x"))).toMatch(
      /outside the allow-list: AmbiguousCommit/,
    );
    expect(surfacedErrorViolation("write", new BaerlyError("InvalidConfig", "x"))).toMatch(
      /outside the allow-list: InvalidConfig/,
    );
    expect(surfacedErrorViolation("gc", new TypeError("boom"))).toMatch(
      /non-BaerlyError: TypeError/,
    );
    expect(surfacedErrorViolation("gc", "string")).toMatch(/non-BaerlyError: string/);
  });

  test("tolerates the known abort relabel only when the cause is the abort", () => {
    const abort = Object.assign(new Error("x"), { name: "AbortError" });
    expect(
      surfacedErrorViolation("gc", new BaerlyError("InvalidResponse", "x", { cause: abort })),
    ).toBeUndefined();
    expect(surfacedErrorViolation("gc", new BaerlyError("InvalidResponse", "x"))).toMatch(
      /outside the allow-list: InvalidResponse/,
    );
    expect(
      surfacedErrorViolation(
        "gc",
        new BaerlyError("InvalidResponse", "x", { cause: new TypeError("t") }),
      ),
    ).toMatch(/outside the allow-list: InvalidResponse/);
  });
});
