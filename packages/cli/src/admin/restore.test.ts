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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  casUpdateCurrentJson,
  createGcPending,
  gcPendingKey,
  type GcPending,
  readCurrentJson,
  readGcPending,
} from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
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
  content_scan_cursor: "deadbeef",
  log_scan_cursor: "3",
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

  test("re-running without --force on a populated target → Conflict (exit 3)", async () => {
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
    expect(stderr.captured.join("")).toContain("pass --force to truncate");
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
    // --force advances tail_hint past the old log entries (stale log
    // files are unreferenced and reclaimed on the next GC pass);
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
    // `log/<seq>` create cannot collide with the old generation. GC decides
    // content liveness by reachability rather than by the floor, and the
    // reseed sets `snapshot: null`, so the old generation becomes
    // unreachable and is swept as `orphan-content` — the intent of
    // truncating. See the FLOOR EXEMPTION comment in `restore.ts`.
    //
    // This case is the empty-prefix extreme (floor → 0); the next test
    // covers the partial-sweep case, which is what actually happens under
    // a budget-bounded GC.
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    await expect(
      runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      ),
    ).resolves.toBe(0);

    // Drive the collection to the post-compaction steady state: floor
    // advanced to the tail, every stale log object swept by GC.
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
    // leaving sub-floor objects behind. The reseed must then land strictly
    // above the highest survivor — which can be below the old floor.
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

  test("malformed line → exit 2, no rows committed", async () => {
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
    expect(exitCode).toBe(2);
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
