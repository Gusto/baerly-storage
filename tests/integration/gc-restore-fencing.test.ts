/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; this suite threads it through the restore CLI
   and reads it back through the collection API. */

/**
 * GC ↔ `baerly admin restore` fencing — the regression suite for a
 * reachable data-loss defect that shipped because **no file in this repo
 * imported both `runGc` and the restore path**. Each half was covered;
 * their interaction was not, and the defect lives exactly in the seam.
 *
 * The hazard, end to end and with no crash anywhere in it:
 *
 *   1. A collection is folded, so `log_seq_start` moves up and the
 *      sub-floor `log/<seq>` objects become stale-log GC candidates.
 *   2. A budget-bounded `runGc` pass sweeps some of them and then LOSES
 *      the `gc/pending.json` CAS. That path returns success by design —
 *      the DELETEs are durable — so the candidates stay in the ledger
 *      naming keys that are already gone. (Pinned on its own in
 *      `packages/server/src/gc.test.ts`, "sticky CAS-loss".)
 *   3. `baerly admin restore --force` reseeds `log_seq_start` from the
 *      SURVIVING log objects. That is the deliberate floor exemption
 *      documented in `restore.ts`, and it can land the new floor BELOW
 *      the old one, because GC walks `log/` in lex order (`0,1,10,11,2,…`)
 *      and therefore sweeps the top of the numeric range before the
 *      middle of it.
 *   4. The restore's own commits now re-create those exact keys INSIDE
 *      the new live range `[log_seq_start, tail)`.
 *   5. The surviving candidates are still bare keys with no identity. The
 *      next pass deletes them — now live — and every read and every fold
 *      throws `Internal` from `walkLogRangeWithBytes`. The collection is
 *      unreadable.
 *
 * THREE independent mechanisms now block that, and knowing this matters
 * before you conclude anything from a green run here:
 *
 *   - the `generation` fence on every `GcCandidate`;
 *   - the sweep gate's re-derived liveness check — these two are the two
 *     conjuncts of `runGc`'s revalidation gate, and **each one closes
 *     this scenario on its own**;
 *   - `admin restore` deleting `gc/pending.json` in both reseed branches.
 *
 * Because any one of the three alone closes the hazard, no single test
 * here can fail when only one is reverted — it would pass for the wrong
 * reason. So `1a` pins the revalidation gate **as a unit** (deleting
 * either conjunct alone leaves `1a` green; deleting both reddens it) and
 * `1b` pins the restore-side clear. The two conjuncts are discriminated
 * separately by the unit tests in `packages/server/src/gc.test.ts` —
 * that is where to look if you need to know which one is carrying a
 * given case, and it is why `1a` does not try to.
 *
 * Backends: `memory://` via the CLI's own bucket-URI parser, so the
 * suite drives the real `runRestore` entry point rather than a
 * re-implementation of it. No infrastructure.
 */

import { Readable } from "node:stream";
import {
  type Collection,
  type DocumentData,
  type GcPending,
  type Storage,
  createGcPending,
  gcPendingKey,
  logObjectKey,
  logSeqStartOf,
  readCurrentJson,
  readGcPending,
} from "@baerly/protocol";
import { Db } from "@baerly/server";
import { compact, runGc } from "@baerly/server/maintenance";
import {
  type InternalCompactOptions,
  type InternalRunGcOptions,
} from "@baerly/server/_internal/testing";
import { describe, expect, test } from "vitest";
import { captureStream } from "../../packages/cli/src/_internal/testing.ts";
import { runRestore } from "../../packages/cli/src/admin/restore.ts";
import { parseBucketUri } from "../../packages/cli/src/bucket-uri.ts";

const APP = "app";
const TENANT = "tenant";
const COLL = "tickets";
const PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;
const CURRENT_JSON_KEY = `${PREFIX}/current.json`;
const PENDING_KEY = gcPendingKey(PREFIX);

interface Row extends DocumentData {
  _id: string;
}

/**
 * 12 seed rows, chosen so the lex order of the resulting `log/<seq>.json`
 * keys (`0, 1, 10, 11, 2, 3, …, 9`) diverges from their numeric order.
 * That divergence is load-bearing: it is what lets a budget-bounded sweep
 * delete the numerically-HIGHEST keys first and leave the middle of the
 * range behind, which is what drops the restore's reseeded floor below
 * the old one.
 */
const SEED_IDS = Array.from({ length: 12 }, (_, i) => `seed-${String(i)}`);
const RESTORE_IDS = ["restored-a", "restored-b", "restored-c"];

const ndjson = (ids: readonly string[]): string =>
  ids.length === 0 ? "" : `${ids.map((id) => JSON.stringify({ _id: id, label: id })).join("\n")}\n`;

let bucketSerial = 0;

/** A fresh `memory://` bucket plus a direct `Storage` handle on it. */
const freshBucket = async (): Promise<{ uri: string; storage: Storage }> => {
  bucketSerial += 1;
  const uri = `memory://gc-restore-fencing-${String(bucketSerial)}`;
  const { storage } = await parseBucketUri(uri);
  return { uri, storage };
};

/**
 * Drive the real `baerly admin restore` entry point. stdout/stderr are
 * captured so the CLI's success envelope doesn't pollute the run.
 */
const restore = async (
  uri: string,
  rows: readonly string[],
  opts: { force: boolean },
): Promise<number> => {
  const stdout = captureStream(process.stdout);
  const stderr = captureStream(process.stderr);
  try {
    return await runRestore(
      [
        `--bucket=${uri}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        ...(opts.force ? ["--force"] : []),
      ],
      { streams: { stdin: Readable.from([Buffer.from(ndjson(rows), "utf8")]) } },
    );
  } finally {
    stderr.restore();
    stdout.restore();
  }
};

/** Every `_id` visible through the locked collection API, sorted. */
const readAllRowIds = async (storage: Storage): Promise<string[]> => {
  const db = Db.create({ storage, app: APP, tenant: TENANT });
  const rows = await (db.collection(COLL) as Collection<Row>).where({}).all();
  return [...rows].map((r) => r._id).toSorted();
};

/** Which `log/<seq>.json` objects are currently on the bucket, ascending. */
const listLogSeqs = async (storage: Storage): Promise<number[]> => {
  const seqs: number[] = [];
  for await (const entry of storage.list(`${PREFIX}/log/`)) {
    const match = /\/log\/(\d+)\.json$/.exec(entry.key);
    if (match !== null) {
      seqs.push(Number.parseInt(match[1]!, 10));
    }
  }
  return seqs.toSorted((a, b) => a - b);
};

/**
 * Build the pre-restore bucket state: a folded collection whose ledger
 * carries STICKY candidates naming keys a budget-bounded sweep has
 * already deleted.
 *
 * Two GC passes, because the sticky state needs a candidate that was
 * already durable in the ledger before the pass that swept it:
 *   - pass 1 marks under `maxSweepsPerRun: 0`, so the marks persist and
 *     nothing is deleted;
 *   - pass 2 sweeps them and loses every `gc/pending.json` CAS, so the
 *     DELETEs land but the removals never do.
 */
const buildStickyLedger = async (): Promise<{
  uri: string;
  storage: Storage;
  sticky: GcPending;
}> => {
  const { uri, storage } = await freshBucket();
  await expect(restore(uri, SEED_IDS, { force: false })).resolves.toBe(0);

  // Fold everything, so every `log/<seq>` below the new floor is stale.
  await compact({ storage, currentJsonKey: CURRENT_JSON_KEY }, {
    minEntriesToCompact: 1,
    maxEntriesPerRun: 100,
  } as InternalCompactOptions);

  // Pass 1 — mark the lex-first window, sweep nothing.
  await runGc({ storage, currentJsonKey: CURRENT_JSON_KEY }, {
    graceMillis: 0,
    maxMarksPerRun: 4,
    maxSweepsPerRun: 0,
  } as InternalRunGcOptions);

  // Pass 2 — sweep them, and lose every CAS on the ledger so the removal
  // never persists. Same rival-CAS interception the unit-level sticky
  // test uses, with the same `inRival` re-entrancy guard.
  const origPut = storage.put.bind(storage);
  let inRival = false;
  storage.put = (async (key, body, putOpts) => {
    if (key === PENDING_KEY && putOpts?.ifMatch !== undefined && !inRival) {
      inRival = true;
      try {
        const latest = await readGcPending(storage, PENDING_KEY);
        if (latest !== null) {
          await origPut(
            PENDING_KEY,
            new TextEncoder().encode(JSON.stringify({ ...latest.json, last_swept_at: "rival" })),
            { ifMatch: latest.etag, contentType: "application/json" },
          );
        }
      } finally {
        inRival = false;
      }
    }
    return origPut(key, body, putOpts);
  }) as typeof storage.put;

  try {
    await runGc({ storage, currentJsonKey: CURRENT_JSON_KEY }, {
      graceMillis: 0,
      maxSweepsPerRun: 4,
    } as InternalRunGcOptions);
  } finally {
    // `MemoryStorage` handles are shared per bucket via the registry, so
    // leaving the rival-CAS interceptor installed after a throw would
    // leak it into every later use of this bucket.
    storage.put = origPut;
  }

  const ledger = await readGcPending(storage, PENDING_KEY);
  expect(ledger).not.toBeNull();
  return { uri, storage, sticky: ledger!.json };
};

describe("GC candidates across `baerly admin restore`", () => {
  test("the pre-restore fixture really is the hazardous state", async () => {
    // Not a fix test — a fixture test. Every assertion below is a
    // precondition the two ABA tests depend on, and each one is a thing
    // that could quietly stop being true (a change to GC's lex-order
    // walk, to the mark budget, to `tailFromListedLogKeys`). If this
    // drifts, the ABA tests would still pass while no longer exercising
    // the ABA — the exact failure mode the brief warns about.
    const { storage, sticky } = await buildStickyLedger();

    const stickyKeys = sticky.candidates.map((c) => c.key);
    // The lex-first window is `0, 1, 10, 11` — note 10 and 11 are the
    // numerically-highest keys in the collection, and they are swept
    // while 2..9 survive. That inversion is the whole mechanism.
    expect(stickyKeys).toEqual([
      logObjectKey(PREFIX, 0),
      logObjectKey(PREFIX, 1),
      logObjectKey(PREFIX, 10),
      logObjectKey(PREFIX, 11),
    ]);
    // The DELETEs landed…
    await expect(listLogSeqs(storage)).resolves.toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    // …so the candidates are sticky: they name keys that no longer exist.
    for (const key of stickyKeys) {
      await expect(storage.get(key)).resolves.toBeNull();
    }
    // Every candidate is due, and carries the pre-restore generation.
    const before = await readCurrentJson(storage, CURRENT_JSON_KEY);
    for (const cand of sticky.candidates) {
      expect(Date.parse(cand.due_at)).toBeLessThanOrEqual(Date.now());
      expect(cand.generation).toBe(before?.json.generation);
    }
  });

  test("1a — the sweep gate refuses a candidate that outlived its collection", async () => {
    // Pins `runGc`'s revalidation gate AS A UNIT, not either conjunct.
    //
    // Do not read a green run here as evidence that the `generation`
    // fence is load-bearing: delete the fence and keep the liveness
    // check and this test still passes, because the re-created `log/10`
    // is now at/above the floor and reads as LIVE. Delete the liveness
    // check and keep the fence and it also passes. Only removing BOTH —
    // the pre-change two-way gate of a budget counter and
    // `due_at <= now` — reddens it. The two conjuncts are discriminated
    // individually in `packages/server/src/gc.test.ts`.
    //
    // The ledger is re-planted after the restore, byte for byte as GC
    // left it. That is not a contrivance to force a failure — it is the
    // state of any bucket reseeded without the ledger clear: an older
    // `baerly` binary, or a future reseed path that forgets it. The
    // clear is defence in depth (its own JSDoc says so); the sweep gate
    // is the invariant, and this is what proves the invariant carries
    // the weight alone. Reverting the clear therefore leaves this test
    // GREEN, correctly — test 1b covers that fix.
    const { uri, storage, sticky } = await buildStickyLedger();

    await expect(restore(uri, RESTORE_IDS, { force: true })).resolves.toBe(0);

    // The floor DROPPED: the surviving log objects were 2..9, so the
    // reseed lands at 10 — below the old floor of 12. The restore's own
    // commits then re-create log/10 and log/11, the very keys two sticky
    // candidates still name.
    const after = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(logSeqStartOf(after!.json)).toBe(10);

    // Re-plant the ledger exactly as GC left it, then run GC again. The
    // delete first is not incidental: the restore's own row commits tick
    // in-band maintenance, which runs `runGc` inline and bootstraps a
    // FRESH ledger against the new generation. So "the sticky ledger
    // survived the reseed" has to be re-established explicitly.
    //
    // Not byte-fidelity with a bucket whose reseed never cleared the
    // ledger: in that bucket the restore's own in-band pass would have
    // merged into the surviving ledger, resolving some candidates on the
    // way through. What is re-planted here is the pre-restore ledger
    // untouched, which is the same candidate set that bucket would have
    // started from and strictly more adversarial than what it would have
    // been left holding.
    await storage.delete(PENDING_KEY);
    await createGcPending(storage, PENDING_KEY, sticky);
    const r = await runGc({ storage, currentJsonKey: CURRENT_JSON_KEY }, {
      graceMillis: 0,
    } as InternalRunGcOptions);

    // The harm this whole change exists to prevent, asserted first: every
    // restored row is still readable, and no `Internal` escapes
    // `walkLogRangeWithBytes`. Against the pre-change two-way sweep gate
    // this rejects with `Internal: log/10.json missing`.
    //
    // Attribution warning for a future debugger: this assertion is a
    // full read-back through `Db` + the collection API, so it also
    // reddens on any write-path, log-walk, or restore regression that
    // has nothing to do with GC. A red 1a is not on its own evidence
    // about the sweep gate — check `packages/server/src/gc.test.ts` and
    // the writer suites first, and read the two assertions below, which
    // name the deleted-vs-surviving key sets directly.
    await expect(readAllRowIds(storage)).resolves.toEqual([...RESTORE_IDS].toSorted());
    // The mechanism behind it: nothing inside the live range `[10, 13)`
    // was deleted…
    await expect(listLogSeqs(storage)).resolves.toEqual([10, 11, 12]);
    // …while the pass still did real work — the genuinely dead sub-floor
    // keys 2..9 went away. The gate refused the live range specifically,
    // it did not simply stop sweeping.
    expect(r.swept).toBeGreaterThan(0);
  });

  test("1b — `restore --force` clears the sticky ledger a real GC pass left behind", async () => {
    // Pins the SECOND fix, in isolation. The discriminating assertion is
    // that the ledger object is GONE after the reseed — not that the rows
    // survive, because the generation fence makes them survive either
    // way. Reverting the fence leaves this test green; test 1a covers it.
    //
    // On its own assertion this overlaps `packages/cli/src/admin/restore.test.ts`:
    // its two ledger-clear cases redden under the same mutation, and they
    // already derive their key through `gcPendingKey`. The marginal value
    // here is KEY COHERENCE between the two components, and it comes from
    // `buildStickyLedger` rather than from the assertion below — the
    // ledger is whatever a real `runGc` pass wrote, at whatever key `gc.ts`
    // chose. Point `gc.ts`'s `pendingKey` somewhere else and every test in
    // this file reddens while `restore.test.ts` stays green, because that
    // file writes the ledger itself.
    //
    // The reseed carries NO rows, and that is deliberate. The restore's
    // row commits tick in-band maintenance, which runs `runGc` inline and
    // bootstraps a fresh ledger — so a reseed that carries rows cannot
    // distinguish "the clear happened" from "the clear did not happen and
    // the generation fence dropped the stale candidates instead". An
    // empty reseed observes the clear directly, with nothing in between.
    const { uri, storage, sticky } = await buildStickyLedger();
    expect(sticky.candidates.length).toBeGreaterThan(0);
    // The rotation cursor is part of why a surviving ledger is not
    // harmless even once its candidates are fenced: it would resume the
    // next scan mid-keyspace of a collection that no longer exists.
    expect(sticky.log_scan_cursor).toBe(logObjectKey(PREFIX, 11));

    await expect(restore(uri, [], { force: true })).resolves.toBe(0);

    // The reseed happened…
    const after = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(logSeqStartOf(after!.json)).toBe(10);
    // …and took the ledger — candidates, rotation cursor and all — with it.
    await expect(readGcPending(storage, PENDING_KEY)).resolves.toBeNull();
  });

  test("1c — a GC pass in flight when the ledger is cleared still returns", async () => {
    // The cost of 1b's fix, and the reason it needs one. Before this
    // branch nothing in the system ever deleted `gc/pending.json`, so
    // "the ledger vanished mid-pass" was unreachable; the clear makes it
    // routine, and `runGc` holds the ledger only as an in-memory read
    // between step 2 and its step-7 CAS.
    //
    // Schedule, all of it steady-state: a pass reads the ledger, the
    // operator's `admin restore` deletes it, the pass issues its sweep
    // DELETEs, then the pass CASes. `casUpdateGcPending` reports the
    // missing key as `Conflict` — a failed If-Match precondition, the
    // same code the storage layer would raise on a bare conditional PUT
    // — which `runGc`'s step-7 arm already tolerates as a lost race.
    //
    // Against the pre-fix `InvalidResponse` this throws out of `runGc`:
    // on the write-tick path `runBoundedMaintenance` counts an
    // alert-grade `db.maintenance.unexpected_error_total`, and on the
    // `runScheduledMaintenance` path (documented "Errors propagate") an
    // operator's cron reports a corrupt-data code during a routine
    // restore.
    //
    // The interceptor stands in for the restore rather than running one
    // concurrently: `runGc` is a single `await` chain from the test's
    // point of view, so the delete has to be driven from inside it to
    // land in the window deterministically. Hooking the sweep DELETE is
    // the schedule above, at the point the brief describes.
    const { storage } = await buildStickyLedger();
    const origDelete = storage.delete.bind(storage);
    let ledgerCleared = false;
    storage.delete = (async (key, opts) => {
      const result = await origDelete(key, opts);
      if (!ledgerCleared && key !== PENDING_KEY) {
        ledgerCleared = true;
        await origDelete(PENDING_KEY);
      }
      return result;
    }) as typeof storage.delete;

    try {
      const r = await runGc({ storage, currentJsonKey: CURRENT_JSON_KEY }, {
        graceMillis: 0,
      } as InternalRunGcOptions);
      // The window was actually entered — a pass that swept nothing
      // would never have called `storage.delete` and would prove
      // nothing.
      expect(ledgerCleared).toBe(true);
      expect(r.swept).toBeGreaterThan(0);
    } finally {
      // `MemoryStorage` handles are shared per bucket via the registry;
      // an interceptor left installed leaks into every later use.
      storage.delete = origDelete;
    }

    // The pass did NOT resurrect the ledger the restore deleted — the
    // step-7 arm is best-effort, not a re-create. The next pass
    // bootstraps a fresh one against the new generation.
    await expect(readGcPending(storage, PENDING_KEY)).resolves.toBeNull();
  });
});
