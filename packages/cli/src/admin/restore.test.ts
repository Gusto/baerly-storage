/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; this test threads it
   through writer + restore CLI. */

/**
 * CLI test for `baerly admin restore`.
 *
 * Streams canonical NDJSON via the programmatic `streams.stdin` hook
 * on `runRestore`, asserts the post-state `tail_hint` equals the row
 * count, and exercises the `--force` / pre-existing / malformed-line
 * branches.
 */

import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  casUpdateCurrentJson,
  createGcPending,
  gcPendingKey,
  type GcPending,
  readCurrentJson,
  readGcPending,
  BaerlyError,
  type DocumentData,
  MAX_DOCUMENT_BYTES,
} from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { Writer } from "@baerly/server/_internal/testing";
import { canonicalStringify, runDump } from "./dump.ts";
import { runRestore } from "./restore.ts";
import { captureStream } from "../_internal/testing.ts";

const APP = "app";
const TENANT = "tenant";
const COLL = "tickets";
const CURRENT_JSON_KEY = `app/${APP}/tenant/${TENANT}/manifests/${COLL}/current.json`;
const TABLE_PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;
const GC_PENDING_KEY = gcPendingKey(TABLE_PREFIX);

/** A populated `gc/pending.json` body, shaped like a real post-mark ledger. */
const STALE_GC_PENDING: GcPending = {
  schema_version: 1,
  candidates: [
    {
      key: `${TABLE_PREFIX}/log/0.json`,
      due_at: "2020-01-01T00:00:00.000Z",
      reason: "stale-log",
    },
  ],
  last_swept_at: "2020-01-01T00:00:00.000Z",
};

const CANONICAL_NDJSON =
  `{"_id":"t-1","status":"open","title":"first"}\n` +
  `{"_id":"t-2","meta":{"x":1,"y":2},"title":"second"}\n`;

describe("baerly admin restore", () => {
  let root: string;
  let storage: LocalFsStorage;
  let stdinPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "baerly-restore-"));
    storage = new LocalFsStorage({ root });
    stdinPath = join(root, "in.ndjson");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  test("seeds a fresh bucket and lands tail_hint === rowCount", async () => {
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const exitCode = await runRestore(
      [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
      { streams: { stdin: createReadStream(stdinPath) } },
    );
    expect(exitCode).toBe(0);
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head).not.toBeNull();
    expect(head?.json.tail_hint).toBe(2);
  });

  test("fresh non-empty restore (N=2) has N+2 PUTs and no list iterator walk", async () => {
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const put = vi.spyOn(LocalFsStorage.prototype, "put");
    const list = vi.spyOn(LocalFsStorage.prototype, "list");

    await expect(
      runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      ),
    ).resolves.toBe(0);

    expect(put).toHaveBeenCalledTimes(4);
    expect(list).toHaveBeenCalledTimes(0);
  });

  test("force non-empty restore (N=1) has N+2 PUTs and one list iterator walk", async () => {
    await writeFile(stdinPath, `{"_id":"old","status":"old"}\n`, "utf8");
    await expect(
      runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      ),
    ).resolves.toBe(0);
    const put = vi.spyOn(LocalFsStorage.prototype, "put");
    const list = vi.spyOn(LocalFsStorage.prototype, "list");
    put.mockClear();
    list.mockClear();

    await writeFile(stdinPath, `{"_id":"new","status":"new"}\n`, "utf8");
    await expect(
      runRestore(
        [
          `--bucket=file://${root}`,
          `--app=${APP}`,
          `--tenant=${TENANT}`,
          `--collection=${COLL}`,
          "--force",
        ],
        { streams: { stdin: createReadStream(stdinPath) } },
      ),
    ).resolves.toBe(0);

    expect(put).toHaveBeenCalledTimes(3);
    // This counts one Storage.list() iterator invocation. A paginated
    // provider may satisfy that single iterator with P billable LIST requests.
    expect(list).toHaveBeenCalledTimes(1);
  });

  test("fresh empty restore has one PUT and no list iterator walk", async () => {
    await writeFile(stdinPath, "", "utf8");
    const put = vi.spyOn(LocalFsStorage.prototype, "put");
    const list = vi.spyOn(LocalFsStorage.prototype, "list");

    await expect(
      runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      ),
    ).resolves.toBe(0);

    expect(put).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(0);
  });

  test("force empty restore has one PUT and one list iterator walk", async () => {
    await writeFile(stdinPath, `{"_id":"old","status":"old"}\n`, "utf8");
    await expect(
      runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      ),
    ).resolves.toBe(0);
    const put = vi.spyOn(LocalFsStorage.prototype, "put");
    const list = vi.spyOn(LocalFsStorage.prototype, "list");
    put.mockClear();
    list.mockClear();

    await writeFile(stdinPath, "", "utf8");
    await expect(
      runRestore(
        [
          `--bucket=file://${root}`,
          `--app=${APP}`,
          `--tenant=${TENANT}`,
          `--collection=${COLL}`,
          "--force",
        ],
        { streams: { stdin: createReadStream(stdinPath) } },
      ),
    ).resolves.toBe(0);

    expect(put).toHaveBeenCalledTimes(1);
    // This is one iterator walk, not proof of one provider LIST request.
    expect(list).toHaveBeenCalledTimes(1);
  });

  test("re-running without --force on a populated target → AlreadyExists (exit 3)", async () => {
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const first = await runRestore(
      [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
      { streams: { stdin: createReadStream(stdinPath) } },
    );
    expect(first).toBe(0);
    const stderr = captureStream(process.stderr);
    let second: number;
    try {
      second = await runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      );
    } finally {
      stderr.restore();
    }
    expect(second).toBe(3);
    const output = stderr.captured.join("");
    expect(output).toContain(": AlreadyExists: ");
    expect(output).toContain(`collection "${COLL}"`);
    expect(output).toContain("pass --force to truncate");
  });

  test("re-running with --force truncates and reseeds", async () => {
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const first = await runRestore(
      [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
      { streams: { stdin: createReadStream(stdinPath) } },
    );
    expect(first).toBe(0);

    // Second run: feed three rows so we can confirm the seed was
    // reset (tail_hint = 3, not 5 = 2 + 3).
    const secondNdjson = `{"_id":"u-1","x":1}\n{"_id":"u-2","x":2}\n{"_id":"u-3","x":3}\n`;
    await writeFile(stdinPath, secondNdjson, "utf8");
    const second = await runRestore(
      [
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--force",
      ],
      { streams: { stdin: createReadStream(stdinPath) } },
    );
    expect(second).toBe(0);
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    // --force advances tail_hint past the old log entries (the old log
    // files are unreferenced and reclaimed by computed-range retirement);
    // the second run's 3 inserts add 3 more, giving tail_hint = 5.
    expect(head?.json.tail_hint).toBe(5);
    // log_seq_start tracks the truncation point — every entry from
    // the old generation is past the live tail.
    expect(head?.json.log_seq_start).toBe(2);
    // --force bumps the fence epoch — go from 0 to 1.
    expect(head?.json.writer_fence.epoch).toBeGreaterThanOrEqual(1);
  });

  test("--force may reset log_seq_start below the old floor — the deliberate admin exemption", async () => {
    // `casUpdateCurrentJson` rejects any floor regression. `--force` is the
    // one path that lowers the floor on purpose, and it reaches storage by
    // its own If-Match PUT rather than through that helper. This test pins
    // the exemption so it cannot be closed by accident.
    //
    // Why it is sound: the reseed floor is `max(listed log seq) + 1`, so it
    // is strictly above every log object still present and the committing
    // `log/<seq>` create cannot collide with the old generation. The
    // reseed sets `snapshot: null`, so the old generation becomes
    // unreachable to every reader — the intent of truncating. Sub-fold-floor
    // `log/` survivors are reclaimed by computed-range retirement; legacy
    // `content/` side objects are left in place and are inert. See the
    // FLOOR EXEMPTION comment in `restore.ts`.
    //
    // This case is the empty-prefix extreme (floor → 0); the next test
    // covers the partial-survivor case, which is what a budget-bounded
    // or crash-interrupted retirement pass leaves behind.
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    await expect(
      runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      ),
    ).resolves.toBe(0);

    // Drive the collection to the post-compaction steady state: floor
    // advanced to the tail, every sub-floor log object retired.
    await casUpdateCurrentJson(storage, CURRENT_JSON_KEY, (c) => ({
      ...c,
      log_seq_start: c.tail_hint,
    }));
    for await (const entry of storage.list(`${TABLE_PREFIX}/log/`)) {
      await storage.delete(entry.key);
    }
    const before = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(before?.json.log_seq_start).toBe(2);

    await writeFile(stdinPath, `{"_id":"v-1","x":1}\n`, "utf8");
    await expect(
      runRestore(
        [
          `--bucket=file://${root}`,
          `--app=${APP}`,
          `--tenant=${TENANT}`,
          `--collection=${COLL}`,
          "--force",
        ],
        { streams: { stdin: createReadStream(stdinPath) } },
      ),
    ).resolves.toBe(0);

    // The floor legitimately went 2 → 0: the log prefix was empty, so there
    // was nothing to skip past.
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head?.json.log_seq_start).toBe(0);
    expect(head?.json.tail_hint).toBe(1);
  });

  test("--force reseeds above surviving log objects even when that lowers the floor", async () => {
    // The realistic shape, and the one the exemption's soundness argument
    // actually rests on. GC's sweep is budget-bounded and walks `log/` in
    // lex order, so it routinely clears the TOP of the old range while
    // leaving sub-fold-floor objects behind. The reseed must then land
    // strictly above the highest survivor — which can be below the old fold
    // floor.
    //
    // Here: fold the whole range (floor → 2), then sweep only `log/1`.
    // `log/0` survives, so `truncatedNext` is 1 — below the old floor of 2,
    // with an old-generation object still on the bucket. That refutes any
    // "the floor only drops once every entry beneath it is gone" reading.
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    await expect(
      runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      ),
    ).resolves.toBe(0);

    await casUpdateCurrentJson(storage, CURRENT_JSON_KEY, (c) => ({
      ...c,
      log_seq_start: c.tail_hint,
    }));
    await storage.delete(`${TABLE_PREFIX}/log/1.json`);
    const before = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(before?.json.log_seq_start).toBe(2);

    await writeFile(stdinPath, `{"_id":"v-1","x":1}\n`, "utf8");
    await expect(
      runRestore(
        [
          `--bucket=file://${root}`,
          `--app=${APP}`,
          `--tenant=${TENANT}`,
          `--collection=${COLL}`,
          "--force",
        ],
        { streams: { stdin: createReadStream(stdinPath) } },
      ),
    ).resolves.toBe(0);

    // Floor 2 → 1: strictly above the surviving `log/0`, and below the old
    // floor. The survivor is still on the bucket — GC sweeps it later as an
    // unreachable orphan, and readers never walk below the new floor.
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head?.json.log_seq_start).toBe(1);
    const survivors: string[] = [];
    for await (const entry of storage.list(`${TABLE_PREFIX}/log/`)) {
      survivors.push(entry.key);
    }
    expect(survivors).toContain(`${TABLE_PREFIX}/log/0.json`);
  });

  test("--force drops a certified delete floor before reseeding an empty old log", async () => {
    // A nonzero delete floor certifies that every lower log object is gone.
    // When the certified prefix is the entire old log, LIST finds no old
    // survivor and `--force` safely reseeds at 0, below that old floor.
    // Carrying the field through the unchecked truncate PUT would publish
    // `log_delete_floor > log_seq_start`; dropping it correctly resets the
    // new generation to "no deleted prefix is certified."
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    await expect(
      runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      ),
    ).resolves.toBe(0);

    // First advance the fold floor to the old tail. Delete every old log
    // object below it, and only then publish the certified delete floor.
    const folded = await casUpdateCurrentJson(storage, CURRENT_JSON_KEY, (c) => ({
      ...c,
      log_seq_start: c.tail_hint,
    }));
    const oldTail = folded.json.log_seq_start;
    for (let seq = 0; seq < oldTail; seq += 1) {
      await storage.delete(`${TABLE_PREFIX}/log/${seq}.json`);
    }
    await casUpdateCurrentJson(storage, CURRENT_JSON_KEY, (c) => ({
      ...c,
      log_delete_floor: oldTail,
    }));

    const before = await readCurrentJson(storage, CURRENT_JSON_KEY);
    const oldDeleteFloor = before?.json.log_delete_floor ?? 0;
    expect(oldDeleteFloor).toBeGreaterThan(0);
    const oldLogKeys: string[] = [];
    for await (const entry of storage.list(`${TABLE_PREFIX}/log/`)) {
      oldLogKeys.push(entry.key);
    }
    expect(oldLogKeys).toEqual([]);

    await writeFile(stdinPath, `{"_id":"v-1","x":1}\n`, "utf8");
    await expect(
      runRestore(
        [
          `--bucket=file://${root}`,
          `--app=${APP}`,
          `--tenant=${TENANT}`,
          `--collection=${COLL}`,
          "--force",
        ],
        { streams: { stdin: createReadStream(stdinPath) } },
      ),
    ).resolves.toBe(0);

    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head?.json.log_seq_start).toBe(0);
    expect(head?.json.log_seq_start).toBeLessThan(oldDeleteFloor);
    expect(head?.json.log_delete_floor).toBeUndefined();

    // The reseed leaves a manifest that still admits validated transitions.
    // Had the old floor been carried, this no-op CAS would reject it.
    await expect(
      casUpdateCurrentJson(storage, CURRENT_JSON_KEY, (c) => ({ ...c })),
    ).resolves.toBeDefined();
  });

  test("both restore branches mint a generation, and --force re-mints a different one", async () => {
    // The generation nonce is what lets `/v1/since` reject a cursor from
    // the truncated collection. Two things have to hold: the fresh-target
    // seed writes one at all, and `--force` writes a DIFFERENT one —
    // re-using it would leave a pre-restore cursor looking valid and the
    // stream silently gapped, which is issue #73.
    //
    // Note this is exactly what `writer_fence.epoch` cannot do: the
    // fresh-target branch below seeds `epoch: 0`, so a truncate-to-empty
    // is indistinguishable from a genuine epoch-0 collection.
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    await expect(
      runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      ),
    ).resolves.toBe(0);

    const seeded = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(seeded?.json.generation).toMatch(/^[0-9a-f]{12}$/);

    await writeFile(stdinPath, `{"_id":"g-1","x":1}\n`, "utf8");
    await expect(
      runRestore(
        [
          `--bucket=file://${root}`,
          `--app=${APP}`,
          `--tenant=${TENANT}`,
          `--collection=${COLL}`,
          "--force",
        ],
        { streams: { stdin: createReadStream(stdinPath) } },
      ),
    ).resolves.toBe(0);

    const truncated = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(truncated?.json.generation).toMatch(/^[0-9a-f]{12}$/);
    expect(truncated?.json.generation).not.toBe(seeded?.json.generation);
  });

  test("--force clears a populated gc/pending.json ledger as part of the reseed", async () => {
    // A ledger left behind by the reseed names keys from the truncated
    // log — which the restore's own commits may re-create at the same
    // seq — and carries rotation cursors and a pending depth that no
    // longer describe this collection. The reseed must delete the
    // ledger object outright, not merely stop referencing it.
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const first = await runRestore(
      [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
      { streams: { stdin: createReadStream(stdinPath) } },
    );
    expect(first).toBe(0);

    await createGcPending(storage, GC_PENDING_KEY, STALE_GC_PENDING);
    await expect(readGcPending(storage, GC_PENDING_KEY)).resolves.not.toBeNull();

    await writeFile(stdinPath, `{"_id":"u-1","x":1}\n`, "utf8");
    const second = await runRestore(
      [
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--force",
      ],
      { streams: { stdin: createReadStream(stdinPath) } },
    );
    expect(second).toBe(0);
    await expect(readGcPending(storage, GC_PENDING_KEY)).resolves.toBeNull();
  });

  test("fresh-target restore clears a leftover gc/pending.json ledger", async () => {
    // `current.json` absent while a ledger is present. No CLI path
    // produces this — there is no `admin drop` — so it comes from
    // operator surgery (deleting `current.json` by hand, or restoring
    // into a prefix a previous collection used) or a half-finished
    // reseed. The fresh-target branch must clear it too.
    await createGcPending(storage, GC_PENDING_KEY, STALE_GC_PENDING);
    await expect(readGcPending(storage, GC_PENDING_KEY)).resolves.not.toBeNull();

    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const exitCode = await runRestore(
      [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
      { streams: { stdin: createReadStream(stdinPath) } },
    );
    expect(exitCode).toBe(0);
    await expect(readGcPending(storage, GC_PENDING_KEY)).resolves.toBeNull();
  });

  test("restore succeeds when no gc/pending.json ledger exists", async () => {
    // The ledger-clear must be a no-op, not an error, when GC has never
    // run for this collection (the common case).
    await expect(readGcPending(storage, GC_PENDING_KEY)).resolves.toBeNull();
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const exitCode = await runRestore(
      [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
      { streams: { stdin: createReadStream(stdinPath) } },
    );
    expect(exitCode).toBe(0);
    await expect(readGcPending(storage, GC_PENDING_KEY)).resolves.toBeNull();
  });

  test("--force chooses old tail from log keys without decoding malformed old entries", async () => {
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const first = await runRestore(
      [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
      { streams: { stdin: createReadStream(stdinPath) } },
    );
    expect(first).toBe(0);

    await casUpdateCurrentJson(storage, CURRENT_JSON_KEY, (c) => ({ ...c, tail_hint: 0 }));
    await storage.put(`${TABLE_PREFIX}/log/0.json`, new TextEncoder().encode("{not json"), {
      contentType: "application/json",
    });

    await writeFile(stdinPath, `{"_id":"u-1","x":1}\n`, "utf8");
    const second = await runRestore(
      [
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--force",
      ],
      { streams: { stdin: createReadStream(stdinPath) } },
    );
    expect(second).toBe(0);
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head?.json.log_seq_start).toBe(2);
    expect(head?.json.tail_hint).toBe(3);
  });

  test("line missing _id → InvalidConfig (exit 1), no rows committed", async () => {
    // First line is bad (missing _id); confirms the ticket's
    // "no partial-restore state survives when the first line is
    // the failure" semantics.
    await writeFile(stdinPath, `{"missing_id":true}\n`, "utf8");
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      );
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head?.json.tail_hint).toBe(0);
  });

  test("--json emits the success envelope on stdout", async () => {
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runRestore(
        [
          `--bucket=file://${root}`,
          `--app=${APP}`,
          `--tenant=${TENANT}`,
          `--collection=${COLL}`,
          "--json",
        ],
        { streams: { stdin: createReadStream(stdinPath) } },
      );
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { command: string; restored: number; status: string };
    };
    expect(envelope.result.command).toBe("admin.restore");
    expect(envelope.result.status).toBe("ok");
    expect(envelope.result.restored).toBe(2);
  });

  test("empty lines tolerated", async () => {
    await writeFile(stdinPath, `\n${CANONICAL_NDJSON}\n\n`, "utf8");
    const exitCode = await runRestore(
      [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
      { streams: { stdin: createReadStream(stdinPath) } },
    );
    expect(exitCode).toBe(0);
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head?.json.tail_hint).toBe(2);
  });

  test("traversal-shaped _id rejected by Writer.commit → InvalidConfig (exit 1)", async () => {
    // `restore` only checks `_id` is a non-empty string; the systematic
    // guard lives inside `Writer.commit` (`assertDocId`). A `".."` _id
    // would otherwise write a traversal-shaped key — confirm restore
    // surfaces the rejection (InvalidConfig → exit 1) and commits no rows.
    await writeFile(stdinPath, `{"_id":"..","title":"evil"}\n`, "utf8");
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      );
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head?.json.tail_hint).toBe(0);
  });

  test("control-char _id rejected by Writer.commit → InvalidConfig (exit 1)", async () => {
    // A `_id` carrying a C0 control char (NUL) is rejected by the same
    // `assertDocId` guard inside `commit`. Build the NDJSON with a real
    // control char in the JSON-string body via `String.fromCharCode(0)`
    // — no literal control byte in this source file.
    const badId = `doc${String.fromCharCode(0)}evil`;
    await writeFile(stdinPath, `${JSON.stringify({ _id: badId, title: "evil" })}\n`, "utf8");
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      );
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head?.json.tail_hint).toBe(0);
  });

  test("non-NFC _id rejected by Writer.commit → InvalidConfig (exit 1)", async () => {
    // An `_id` must be NFC. Restore does not rewrite ids, so an export
    // holding a row stored before that rule must be normalized first.
    await writeFile(stdinPath, `${JSON.stringify({ _id: "cafe\u0301", title: "nfd" })}\n`, "utf8");
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      );
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("InvalidConfig");
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head?.json.tail_hint).toBe(0);
  });

  describe("per-row validation and partial progress", () => {
    const run = async (ndjson: string): Promise<{ code: number; err: string }> => {
      await writeFile(stdinPath, ndjson, "utf8");
      const stderr = captureStream(process.stderr);
      try {
        const code = await runRestore(
          [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
          { streams: { stdin: createReadStream(stdinPath) } },
        );
        return { code, err: stderr.captured.join("") };
      } finally {
        stderr.restore();
      }
    };
    const redump = async (): Promise<string> => {
      const out = join(root, "redump.ndjson");
      const { createWriteStream } = await import("node:fs");
      const stream = createWriteStream(out);
      const dumpCode = await runDump(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdout: stream } },
      );
      await new Promise<void>((resolve) => stream.end(resolve));
      expect(dumpCode).toBe(0);
      return readFile(out, "utf8");
    };
    const row = (id: string): string => `${JSON.stringify({ _id: id, v: 1 })}\n`;

    test("duplicate _id on line 2 → exit 1, names both lines, 1 row committed", async () => {
      const { code, err } = await run(row("a") + row("a"));
      expect(code).toBe(1);
      expect(err).toContain("InvalidConfig");
      expect(err).toContain('line 2 repeats _id "a" first seen on line 1');
      expect(err).toContain("1 row committed");
      await expect(storage.get(`${TABLE_PREFIX}/log/0.json`)).resolves.not.toBeNull();
      await expect(storage.get(`${TABLE_PREFIX}/log/1.json`)).resolves.toBeNull();
    });

    test("duplicate at line k of n commits exactly k-1 rows", async () => {
      const { code, err } = await run(row("a") + row("b") + row("c") + row("b") + row("d"));
      expect(code).toBe(1);
      expect(err).toContain('line 4 repeats _id "b" first seen on line 2');
      expect(err).toContain("3 rows committed");
      await expect(storage.get(`${TABLE_PREFIX}/log/2.json`)).resolves.not.toBeNull();
      await expect(storage.get(`${TABLE_PREFIX}/log/3.json`)).resolves.toBeNull();
    });

    test("invalid _id at line 2 → exit 1 with escaped _id and committed count", async () => {
      const { code, err } = await run(row("ok") + row("_leading"));
      expect(code).toBe(1);
      expect(err).toContain('line 2 has an invalid _id "_leading"');
      expect(err).toContain("1 row committed");
    });

    test("missing or empty _id → InvalidConfig (exit 1) with line, count, and remedy", async () => {
      const missing = await run(row("a") + '{"v":1}\n');
      expect(missing.code).toBe(1);
      expect(missing.err).toContain("InvalidConfig");
      expect(missing.err).toContain("line 2 missing non-empty string _id");
      expect(missing.err).toContain("1 row committed");
      expect(missing.err).toContain("Add a non-empty string _id");
    });

    test("empty-string _id on the first line → InvalidConfig (exit 1)", async () => {
      const empty = await run('{"_id":""}\n');
      expect(empty.code).toBe(1);
      expect(empty.err).toContain("InvalidConfig");
    });

    test("non-NFC and control-char _ids report line and count", async () => {
      const nfd = await run(row("ok") + row("cafe\u0301"));
      expect(nfd.code).toBe(1);
      expect(nfd.err).toContain("line 2 has an invalid _id");
      expect(nfd.err).toContain("1 row committed");
    });

    test("value outside the document domain (1e999 parses to Infinity) is refused with line and count", async () => {
      const { code, err } = await run(row("a") + '{"_id":"b","n":1e999}\n');
      expect(code).toBe(1);
      expect(err).toContain("InvalidConfig");
      expect(err).toContain('line 2 (_id "b") has an invalid document');
      expect(err).toContain("1 row committed");
      // The remedy must reach stderr, not only the structured error.
      expect(err).toContain("Store a finite number or null");
    });

    test("a row over the per-document size cap is refused with line and count", async () => {
      const big = JSON.stringify({ _id: "b", pad: "x".repeat(MAX_DOCUMENT_BYTES) });
      const { code, err } = await run(`${row("a")}${big}\n`);
      expect(code).toBe(1);
      expect(err).toContain("InvalidConfig");
      expect(err).toContain('line 2 (_id "b") has an invalid document');
      expect(err).toContain("1 row committed");
    });

    test("a dump at the validators' edges restores and re-dumps byte-identical", async () => {
      // Values and ids the new checks must still accept: falsy and empty
      // values, nested empties, numeric extremes, non-ASCII NFC text, an
      // id with punctuation, a long id, and keys
      // that sort differently under code-unit and locale order.
      const edgeRows: DocumentData[] = [
        { _id: "a.b-c_d e", f: false, n: 0, s: "", arr: [], obj: {} },
        {
          _id: "caf\u00e9-\u2603-\ud83d\ude00",
          big: 9007199254740991,
          tiny: 5e-324,
          neg: -1.5e300,
        },
        {
          _id: "x".repeat(200),
          Z: 1,
          a: 2,
          B: 3,
          nested: { z: [1, [2, [3, []]]], A: "\u0000".length },
        },
      ];
      const edge = edgeRows.map((r) => `${canonicalStringify(r)}\n`).join("");
      const { code, err } = await run(edge);
      expect(err).toBe("");
      expect(code).toBe(0);
      await expect(redump()).resolves.toBe(edge);
    });

    test("a valid dump restores and re-dumps byte-identical", async () => {
      const { code } = await run(CANONICAL_NDJSON);
      expect(code).toBe(0);
      await expect(redump()).resolves.toBe(CANONICAL_NDJSON.trimEnd() + "\n");
    });

    test("AmbiguousCommit on line 2 says line 2 may be committed and gives a count range", async () => {
      const real = Writer.prototype.commit;
      let calls = 0;
      vi.spyOn(Writer.prototype, "commit").mockImplementation(async function (this: Writer, ...a) {
        calls++;
        if (calls === 2) {
          throw new BaerlyError("AmbiguousCommit", "the committing create was not resolved");
        }
        return real.apply(this, a);
      });
      const { code, err } = await run(row("a") + row("b") + row("c"));
      expect(code).not.toBe(0);
      expect(err).toContain("AmbiguousCommit");
      expect(err).toContain("line 2 may or may not be committed");
      expect(err).toContain("between 1 and 2 rows");
      expect(err).not.toContain("was not committed");
    });

    test("a definite commit failure still says the line was not committed", async () => {
      const real = Writer.prototype.commit;
      let calls = 0;
      vi.spyOn(Writer.prototype, "commit").mockImplementation(async function (this: Writer, ...a) {
        calls++;
        if (calls === 2) {
          throw new BaerlyError("NetworkError", "boom");
        }
        return real.apply(this, a);
      });
      const { err } = await run(row("a") + row("b"));
      expect(err).toContain("line 2 was not committed");
      expect(err).toContain("1 row committed");
    });

    test("input stream failure reports durable progress and recovery guidance", async () => {
      let committed!: () => void;
      const firstCommit = new Promise<void>((resolve) => {
        committed = resolve;
      });
      const realCommit = Writer.prototype.commit;
      vi.spyOn(Writer.prototype, "commit").mockImplementation(async function (
        this: Writer,
        ...args
      ) {
        const result = await realCommit.apply(this, args);
        committed();
        return result;
      });
      const input = Readable.from(
        (async function* () {
          yield row("a");
          await firstCommit;
          throw new Error("input EIO");
        })(),
      );
      const stderr = captureStream(process.stderr);
      let code: number;
      try {
        code = await runRestore(
          [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
          { streams: { stdin: input } },
        );
      } finally {
        stderr.restore();
      }
      expect(code).toBe(2);
      const err = stderr.captured.join("");
      expect(err).toContain("input EIO");
      expect(err).toContain("1 row committed");
      expect(err).toContain("--force");
      await expect(storage.get(`${TABLE_PREFIX}/log/0.json`)).resolves.not.toBeNull();
      await expect(storage.get(`${TABLE_PREFIX}/log/1.json`)).resolves.toBeNull();
    });

    test("final manifest read failure reports all rows committed", async () => {
      let committed = false;
      const realCommit = Writer.prototype.commit;
      vi.spyOn(Writer.prototype, "commit").mockImplementation(async function (
        this: Writer,
        ...args
      ) {
        const result = await realCommit.apply(this, args);
        committed = true;
        return result;
      });
      const realGet = LocalFsStorage.prototype.get;
      const spy = vi.spyOn(LocalFsStorage.prototype, "get").mockImplementation(async function (
        this: LocalFsStorage,
        key,
        opts,
      ) {
        if (committed && key === CURRENT_JSON_KEY) {
          throw new BaerlyError("NetworkError", "final manifest GET failed");
        }
        return realGet.call(this, key, opts);
      });
      const { code, err } = await run(row("a"));
      expect(code).toBe(2);
      expect(err).toContain("NetworkError");
      expect(err).toContain("all 1 row were committed");
      expect(err).toContain("--force");
      spy.mockRestore();
      await expect(storage.get(`${TABLE_PREFIX}/log/0.json`)).resolves.not.toBeNull();
      await expect(storage.get(`${TABLE_PREFIX}/log/1.json`)).resolves.toBeNull();
    });

    test("tail_hint stamp failure reports all rows committed and the --force rerun, which works", async () => {
      const realPut = LocalFsStorage.prototype.put;
      const spy = vi.spyOn(LocalFsStorage.prototype, "put").mockImplementation(async function (
        this: LocalFsStorage,
        key,
        body,
        opts,
      ) {
        if (opts?.ifMatch !== undefined && String(key).endsWith("current.json")) {
          throw new BaerlyError("NetworkError", "503 service unavailable");
        }
        return realPut.call(this, key, body, opts);
      });
      const failed = await run(row("a") + row("b"));
      expect(failed.code).toBe(2);
      expect(failed.err).toContain("all 2 rows were committed");
      expect(failed.err).toContain("tail_hint");
      expect(failed.err).toContain("--force");
      spy.mockRestore();
      // The advertised remedy: rerun with --force truncates and succeeds.
      await writeFile(stdinPath, row("a") + row("b"), "utf8");
      const rerun = await runRestore(
        [
          `--bucket=file://${root}`,
          `--app=${APP}`,
          `--tenant=${TENANT}`,
          `--collection=${COLL}`,
          "--force",
        ],
        { streams: { stdin: createReadStream(stdinPath) } },
      );
      expect(rerun).toBe(0);
      const head = await readCurrentJson(storage, `${TABLE_PREFIX}/current.json`);
      // --force reseeds above the surviving log slots, then stamps +2.
      expect(head?.json.tail_hint).toBe((head?.json.log_seq_start ?? 0) + 2);
    });

    test("malformed JSON after rows reports committed count (exit 2)", async () => {
      const { code, err } = await run(row("a") + "{nope\n");
      expect(code).toBe(2);
      expect(err).toContain("line 2 is not valid JSON");
      expect(err).toContain("1 row committed");
    });
  });

  test("traversal-shaped --collection rejected at the CLI chokepoint → InvalidConfig (exit 1), writes nothing", async () => {
    // `..` would build a traversal `current.json` key one level up from
    // the manifests prefix. The shared `assertPathSegment` guard must
    // reject it at the CLI chokepoint — fail-fast with an operator-
    // friendly message that names the command + the `collection` role,
    // independent of whatever the backend would do (S3/R2 accept `..`).
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=..`],
        { streams: { stdin: createReadStream(stdinPath) } },
      );
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    const msg = stderr.captured.join("");
    expect(msg).toContain("InvalidConfig");
    expect(msg).toContain("baerly admin restore");
    expect(msg).toContain("collection");
    // Nothing committed: the legitimate collection's key never existed.
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head).toBeNull();
  });

  test("traversal-shaped --app rejected at the CLI chokepoint → InvalidConfig (exit 1)", async () => {
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runRestore(
        [`--bucket=file://${root}`, `--app=..`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      );
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    const msg = stderr.captured.join("");
    expect(msg).toContain("InvalidConfig");
    expect(msg).toContain("app");
  });

  test("traversal-shaped --tenant rejected at the CLI chokepoint → InvalidConfig (exit 1)", async () => {
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=..`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      );
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    const msg = stderr.captured.join("");
    expect(msg).toContain("InvalidConfig");
    expect(msg).toContain("tenant");
  });

  test("unknown flag rejected with exit 1", async () => {
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runRestore([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--unknown=oops",
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("unknown flag");
  });
});
