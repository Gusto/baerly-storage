/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; this suite threads it through the restore CLI
   and reads it back through the collection API. */

/**
 * GC ↔ `baerly admin restore` fencing — the integration seam.
 *
 * This file pins what can only be proven by driving the real
 * `runRestore` entry point against the GC coordination objects:
 *
 *   1. `restore --force` clears `gc/pending.json` on its reseed path, so
 *      candidates marked against the pre-restore incarnation cannot
 *      execute against the new one.
 *   2. The same force reseed re-mints the manifest `generation` — the
 *      fact the GC-side generation fence (unit-pinned in
 *      `packages/server/src/gc.test.ts`, "drops a due candidate whose
 *      generation no longer matches the manifest") relies on restores
 *      to produce a NEW generation, not reuse the old one.
 *
 * Everything else that lived here at the introduction of the fence —
 * the sweep-time revalidation arms, the generation gate, the
 * CAS-tolerance of a pass whose ledger vanished mid-pass — is pinned at
 * unit scope in `packages/server/src/gc.test.ts`. The end-to-end ABA
 * construction that originally motivated this suite (a real GC pass
 * leaving a sticky stale-log ledger, then a reseed re-creating those
 * keys live) required the stale-log mark phase, which the
 * sequence-window retirement program removed; current builds never mark
 * `stale-log` candidates, so that scenario is no longer constructible
 * from a real pass.
 *
 * Backends: `memory://` via the CLI's own bucket-URI parser, so the
 * suite drives the real `runRestore` entry point rather than a
 * re-implementation of it. No infrastructure.
 */

import { Readable } from "node:stream";
import {
  type Storage,
  createGcPending,
  gcPendingKey,
  logObjectKey,
  readCurrentJson,
  readGcPending,
} from "@baerly/protocol";
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

const SEED_IDS = ["seed-0", "seed-1", "seed-2"];
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

/** Drive the real `baerly admin restore` entry point. stdout/stderr are
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

describe("GC ↔ `baerly admin restore` fencing invariants", () => {
  test("restore --force clears the GC ledger", async () => {
    // The restore side of the fence, driven end to end. A ledger left
    // behind by the pre-restore incarnation would carry bare-key
    // candidates with no identity; the force reseed deletes it so none
    // of them can execute against the new incarnation.
    //
    // Empty reseed on purpose: no restore commits ⇒ no write-tick
    // maintenance ⇒ nothing re-bootstraps `gc/pending.json`, so the
    // clear is observable directly. (A non-empty reseed's commits can
    // legitimately leave a FRESH empty ledger behind — that is the
    // next pass's bootstrap, not a survivor.)
    const { uri, storage } = await freshBucket();
    await expect(restore(uri, SEED_IDS, { force: false })).resolves.toBe(0);

    const before = await readCurrentJson(storage, CURRENT_JSON_KEY);

    // Plant a ledger with a due candidate, as a pre-restore build's GC
    // pass would have left behind.
    await createGcPending(storage, PENDING_KEY, {
      schema_version: 1,
      candidates: [
        {
          key: logObjectKey(PREFIX, 0),
          reason: "stale-log",
          due_at: new Date(Date.now() - 1000).toISOString(),
          ...(before?.json.generation !== undefined && {
            generation: String(before.json.generation),
          }),
        },
      ],
      last_swept_at: new Date(Date.now() - 2000).toISOString(),
    });
    await expect(readGcPending(storage, PENDING_KEY)).resolves.not.toBeNull();

    // Force reseed (empty, to observe the clear directly).
    await expect(restore(uri, [], { force: true })).resolves.toBe(0);

    // The ledger is gone: no pre-restore candidate survives to the new
    // incarnation.
    await expect(readGcPending(storage, PENDING_KEY)).resolves.toBeNull();

    // The restore really happened.
    const after = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(after).not.toBeNull();
  });

  test("restore --force re-mints the manifest generation", async () => {
    // The other half of the restore-side fence, and the fact the GC-side
    // generation fence (unit-pinned in gc.test.ts, "drops a due candidate
    // whose generation no longer matches the manifest") relies on
    // restores to produce: a NEW generation, never the old one reused.
    // Real reseed commits here — the non-empty branch — with no ledger
    // assertions (write-tick maintenance may bootstrap a fresh empty
    // ledger; that is unrelated to the generation contract).
    const { uri, storage } = await freshBucket();
    await expect(restore(uri, SEED_IDS, { force: false })).resolves.toBe(0);

    const before = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(before).not.toBeNull();
    const oldGeneration = before?.json.generation ?? 0;

    await expect(restore(uri, RESTORE_IDS, { force: true })).resolves.toBe(0);

    const after = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(after).not.toBeNull();
    const newGeneration = after?.json.generation ?? 0;
    expect(newGeneration).not.toBe(oldGeneration);
  });
});
