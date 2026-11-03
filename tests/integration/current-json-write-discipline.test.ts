/**
 * Lost-update safety of the head: every `current.json` writer is
 * conditional (`If-Match` or `If-None-Match: "*"`). An unconditional head
 * PUT could overwrite a concurrent writer's head (a fold, a fence claim, a
 * floor advance) with one derived from a stale read.
 *
 * A guard over `LocalFsStorage.prototype.put` (so it also sees the storage
 * `baerly admin restore` opens from its `file://` URI) records every PUT to
 * a `.../current.json` key and throws on one with neither precondition.
 * Some paths swallow errors (write-tick maintenance), so each test also
 * asserts the recorded PUTs directly: that the path wrote the head at
 * least once, and that every write carried a precondition.
 *
 * A precondition is not proof it is the right one: an `If-Match` on a fresh
 * re-read rather than the etag the writer derived its head from passes here.
 * The fold-versus-commit cascade in `randomized.test.ts` covers that for
 * the compactor.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ensureTable, LocalFsStorage } from "@baerly/dev";
import {
  BaerlyError,
  casUpdateCurrentJson,
  createCurrentJson,
  encodeJsonBytes,
  MAINTENANCE_TAIL_HINT_REFRESH_WRITES,
  MAINTENANCE_WARN_INTERVAL_WRITES,
  MAINTENANCE_MIN_LIVE_BYTES,
  readCurrentJson,
  type StoragePutOptions,
} from "@baerly/protocol";
import { runRestore } from "../../packages/cli/src/admin/restore.ts";
import { claimWriter } from "../../packages/protocol/src/coordination/current-json.ts";
import { compact, type InternalCompactOptions } from "../../packages/server/src/compactor.ts";
import { retireLogRange } from "../../packages/server/src/log-retention.ts";
import {
  MAINTENANCE_PROFILE_CF_FREE,
  runBoundedMaintenance,
} from "../../packages/server/src/maintenance.ts";
import { Writer } from "../../packages/server/src/writer.ts";
import { logStateCurrentJson, seedLogEntries } from "../fixtures/log-state.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const APP = "app";
const TENANT = "tenant";
const COLL = "tickets";
const PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;
const KEY = `${PREFIX}/current.json`;

type Condition = "if-match" | "if-none-match" | "unconditional";

interface HeadPut {
  readonly key: string;
  readonly condition: Condition;
}

const conditionOf = (opts: StoragePutOptions | undefined): Condition => {
  if (opts?.ifMatch !== undefined) {
    return "if-match";
  }
  return opts?.ifNoneMatch === undefined ? "unconditional" : "if-none-match";
};

const headPuts: HeadPut[] = [];
const conditions = (): Condition[] => headPuts.map((put) => put.condition);

let root: string;
let storage: LocalFsStorage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "baerly-head-cas-"));
  storage = new LocalFsStorage({ root });
  headPuts.length = 0;
  const original = LocalFsStorage.prototype.put;
  vi.spyOn(LocalFsStorage.prototype, "put").mockImplementation(function guardedPut(
    this: LocalFsStorage,
    key,
    body,
    opts,
  ) {
    if (key.endsWith("/current.json")) {
      const condition = conditionOf(opts);
      headPuts.push({ key, condition });
      if (condition === "unconditional") {
        return Promise.reject(new BaerlyError("Internal", `unconditional PUT of ${key}`));
      }
    }
    return original.call(this, key, body, opts);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** Forget the PUTs a test's own setup issued. */
const resetRecorder = (): void => {
  headPuts.length = 0;
};

const commit = async (writer: Writer, i: number): Promise<void> => {
  await writer.commit({
    op: "I",
    collection: COLL,
    docId: `d${String(i)}`,
    body: { _id: `d${String(i)}`, n: i },
  });
};

const restore = async (rows: number, force: boolean): Promise<number> => {
  const ndjson = Array.from(
    { length: rows },
    (_, i) => `${JSON.stringify({ _id: `r${String(i)}`, n: i })}\n`,
  ).join("");
  return runRestore(
    [
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--collection=${COLL}`,
      ...(force ? ["--force"] : []),
    ],
    { streams: { stdin: Readable.from([Buffer.from(ndjson, "utf8")]) } },
  );
};

describe("every current.json write is conditional", () => {
  test("the guard catches an unconditional head PUT", async () => {
    await expect(storage.put(KEY, encodeJsonBytes(logStateCurrentJson()))).rejects.toMatchObject({
      code: "Internal",
    });
    expect(conditions()).toEqual(["unconditional"]);
  });

  test("writer auto-provision creates the head If-None-Match", async () => {
    const writer = new Writer({ storage, currentJsonKey: KEY });
    await commit(writer, 0);
    expect(conditions()).toEqual(["if-none-match"]);
    await expect(readCurrentJson(storage, KEY)).resolves.not.toBeNull();
  });

  test("ensureTable creates the head If-None-Match, including on an existing head", async () => {
    await ensureTable(storage, { app: APP, tenant: TENANT, table: COLL });
    await ensureTable(storage, { app: APP, tenant: TENANT, table: COLL });
    expect(conditions()).toEqual(["if-none-match", "if-none-match"]);
  });

  test("compact(): the probe-budget checkpoint is If-Match", async () => {
    await createCurrentJson(storage, KEY, logStateCurrentJson());
    await seedLogEntries(storage, PREFIX, 0, 100);
    resetRecorder();
    const result = await compact({ storage, currentJsonKey: KEY }, {
      minEntriesToCompact: 50,
      maxEntriesPerRun: 20,
      maxTailProbeGets: 25,
    } as InternalCompactOptions);
    expect(result.skippedReason).toBe("probe-budget-checkpointed");
    expect(conditions()).toEqual(["if-match"]);
  });

  test("compact(): the fold CAS is If-Match", async () => {
    await createCurrentJson(storage, KEY, logStateCurrentJson());
    const writer = new Writer({ storage, currentJsonKey: KEY });
    for (let i = 0; i < 12; i++) {
      await commit(writer, i);
    }
    resetRecorder();
    const result = await compact({ storage, currentJsonKey: KEY }, { minEntriesToCompact: 1 });
    expect(result.written).toBe(true);
    expect(conditions()).toEqual(["if-match"]);
  });

  test("maintenance: the tail_hint refresh is If-Match", async () => {
    await createCurrentJson(storage, KEY, logStateCurrentJson());
    await seedLogEntries(storage, PREFIX, 0, MAINTENANCE_TAIL_HINT_REFRESH_WRITES);
    resetRecorder();
    await runBoundedMaintenance({
      storage,
      currentJsonKey: KEY,
      prevSeq: 0,
      observedTail: MAINTENANCE_TAIL_HINT_REFRESH_WRITES,
      disabled: true,
    });
    expect(conditions()).toEqual(["if-match"]);
    expect((await readCurrentJson(storage, KEY))!.json.tail_hint).toBe(
      MAINTENANCE_TAIL_HINT_REFRESH_WRITES,
    );
  });

  test("maintenance: the deferral warn stamp is If-Match", async () => {
    await createCurrentJson(storage, KEY, logStateCurrentJson());
    const nextSeq = MAINTENANCE_WARN_INTERVAL_WRITES + 5;
    await casUpdateCurrentJson(storage, KEY, (current) => ({
      ...current,
      mean_entry_bytes: MAINTENANCE_MIN_LIVE_BYTES,
      snapshot_rows: 1_000_000, // over the row ceiling ⇒ defer
      tail_hint: nextSeq,
    }));
    resetRecorder();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runBoundedMaintenance(
      { storage, currentJsonKey: KEY, prevSeq: nextSeq },
      { profile: MAINTENANCE_PROFILE_CF_FREE },
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect((await readCurrentJson(storage, KEY))!.json.last_warned_seq).toBe(nextSeq);
    expect(conditions().length).toBeGreaterThan(0);
    expect(conditions().every((c) => c === "if-match")).toBe(true);
  });

  test("log retention's floor CAS is If-Match", async () => {
    await createCurrentJson(
      storage,
      KEY,
      logStateCurrentJson({ tail_hint: 100, log_seq_start: 100, snapshot: `${PREFIX}/s.json` }),
    );
    resetRecorder();
    const result = await retireLogRange(storage, KEY, { window: 10 });
    expect(result.deleted).toBeGreaterThan(0);
    expect(conditions()).toEqual(["if-match"]);
  });

  test("claimWriter's claim and stamp are both If-Match", async () => {
    await createCurrentJson(storage, KEY, logStateCurrentJson());
    resetRecorder();
    await claimWriter(storage, KEY, "worker-a");
    expect(conditions()).toEqual(["if-match", "if-match"]);
  });

  test("restore into a fresh target: the seed is If-None-Match, the post-load stamp If-Match", async () => {
    await expect(restore(3, false)).resolves.toBe(0);
    expect(conditions()).toEqual(["if-none-match", "if-match"]);
  });

  test("restore --force: the reseed and the post-load stamp are If-Match", async () => {
    await expect(restore(2, false)).resolves.toBe(0);
    resetRecorder();
    await expect(restore(3, true)).resolves.toBe(0);
    expect(conditions()).toEqual(["if-match", "if-match"]);
  });
});
