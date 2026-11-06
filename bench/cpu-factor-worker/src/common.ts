/**
 * Fold-cell core for the CPU-factor bench, built from the current tree.
 * Synthetic data only: `_id`s are `d000123`, bodies are a counter plus `x`
 * padding.
 *
 * Fixtures (a collection already seeded, folded, and carrying a 15-entry
 * live tail) are built at build time under Node, because building them costs
 * far more than Free's 10 ms. A request replays one fixture into a fresh
 * in-isolate MemoryStorage, then runs the folding invocation: the write that
 * reaches the fold (pre-commit point read + commit) and one compact() pass at
 * the Cloudflare Free options.
 */
import {
  type CurrentJson,
  decodeJsonBytes,
  logObjectKey,
  MAINTENANCE_MAX_FOLD_BYTES_DEFAULT,
  MAINTENANCE_MAX_FOLD_ROWS,
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_PROFILE_NODE,
  MemoryStorage,
} from "@baerly/protocol";
import { compact, type InternalCompactOptions } from "../../../packages/server/src/compactor.ts";
import { foldChunkedSnapshotReference } from "../../../packages/server/src/chunked-snapshot-reference.ts";
import { Db } from "../../../packages/server/src/db.ts";
import { CLOUDFLARE_FREE_TIER } from "../../../packages/server/src/maintenance.ts";
import {
  createObservabilityContext,
  runWithContext,
} from "../../../packages/server/src/observability/context.ts";
import { loadSnapshotAsMap } from "../../../packages/server/src/snapshot.ts";
import type { FixtureSpec } from "./cells.ts";

export const KEY = "app/g/tenant/t/manifests/notes/current.json";
export const PRE_TAIL = 15;

export interface Fixture {
  readonly objects: Record<string, string>;
  readonly timedId: string;
  readonly logSeqStart: number;
  readonly rows: number;
  readonly bytes: number;
  /** The snapshot the head pointed at before the tail was added. */
  readonly snapshotKey: string | null;
}

const pad = (i: number) => `d${String(i).padStart(6, "0")}`;

const makeRand = () => {
  let seed = 12_345;
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
};

const drain = async (storage: MemoryStorage) => {
  for (let i = 0; i < 1000; i++) {
    const r = await compact({ storage, currentJsonKey: KEY }, { minEntriesToCompact: 1 });
    if (r.entriesFolded === 0) {
      return;
    }
  }
};

const readHead = async (storage: MemoryStorage) =>
  decodeJsonBytes<CurrentJson>((await storage.get(KEY))!.body);

/**
 * The seeding host's profile: Free's write-tick cadence and per-pass caps, but
 * the Node fold ceilings. The "C" and "E" fixtures sit AT Free's ceilings (the
 * Worker measures folds on those exact bytes), so seeding them under Free's own
 * ceilings would make the capacity refusal reject the inserts that build them.
 * The build step is a harness, not the system under test.
 */
const SEEDING_PROFILE = {
  ...MAINTENANCE_PROFILE_CF_FREE,
  maxFoldBytes: MAINTENANCE_PROFILE_NODE.maxFoldBytes,
  maxFoldRows: MAINTENANCE_PROFILE_NODE.maxFoldRows,
};

/** Build-time only (Node): seed, fold to quiescence, then leave a 15-entry tail. */
export const buildFixture = (spec: FixtureSpec): Promise<Fixture> =>
  Promise.resolve(
    runWithContext(
      createObservabilityContext({ maintenance: { options: { profile: SEEDING_PROFILE } } }),
      () => buildFixtureInner(spec),
    ),
  );

const buildFixtureInner = async (spec: FixtureSpec): Promise<Fixture> => {
  const rand = makeRand();
  const storage = new MemoryStorage();
  const notes = Db.create({ storage, app: "g", tenant: "t" }).collection("notes");
  const p = "x".repeat(spec.payload);
  for (let i = 0; i < spec.rows; i++) {
    await notes.insert({ _id: pad(i), n: 0, p });
    if (i % 100 === 99) {
      await drain(storage);
    }
  }
  await drain(storage);
  const head = await readHead(storage);
  for (let k = 0; k < PRE_TAIL; k++) {
    await notes.update(pad(Math.floor(rand() * spec.rows)), { n: k + 1 });
  }
  const timedId = pad(Math.floor(rand() * spec.rows));
  // Keep only what the head reaches: current.json, its snapshot, and the
  // live log tail. Superseded snapshots and folded log entries stay
  // out of the bundle.
  const prefix = KEY.slice(0, -"/current.json".length);
  const keep = [KEY];
  if (typeof head.snapshot === "string") {
    keep.push(head.snapshot);
  }
  for (let seq = head.log_seq_start; ; seq++) {
    const key = logObjectKey(prefix, seq);
    if ((await storage.get(key)) === null) {
      break;
    }
    keep.push(key);
  }
  const objects: Record<string, string> = {};
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const key of keep) {
    const got = await storage.get(key);
    const text = decoder.decode(got!.body);
    if (new TextEncoder().encode(text).byteLength !== got!.body.byteLength) {
      throw new Error(`fixture object ${key} does not round-trip as UTF-8`);
    }
    objects[key] = text;
  }
  return {
    objects,
    timedId,
    logSeqStart: head.log_seq_start,
    snapshotKey: head.snapshot,
    rows: head.snapshot_rows,
    bytes: head.snapshot_bytes,
  };
};

const encoded = new WeakMap<Fixture, Array<[string, Uint8Array]>>();

/** Replay a fixture into a fresh MemoryStorage. Encoding is cached per isolate. */
export const loadFixture = async (
  fx: Fixture,
): Promise<{ storage: MemoryStorage; cold: boolean }> => {
  let entries = encoded.get(fx);
  const cold = entries === undefined;
  if (entries === undefined) {
    const enc = new TextEncoder();
    entries = Object.entries(fx.objects).map(([k, v]) => [k, enc.encode(v)]);
    encoded.set(fx, entries);
  }
  const storage = new MemoryStorage();
  for (const [k, v] of entries) {
    await storage.put(k, v);
  }
  return { storage, cold };
};

export interface InvocationParams {
  /** "all" = write + fold (the gate subject); "write" or "fold" alone; "load" = replay only. */
  readonly part: "all" | "write" | "fold" | "load";
  /** Fold at most this many live entries (1..16); the work fraction knob. */
  readonly entries: number;
}

export const runInvocation = async (fx: Fixture, params: InvocationParams) => {
  const { storage, cold } = await loadFixture(fx);
  let folded = 0;
  let written = false;
  let skipped: string | undefined;
  if (params.part === "load") {
    return { cold, folded, written, skipped };
  }
  if (params.part === "all" || params.part === "write") {
    await Db.create({ storage, app: "g", tenant: "t" })
      .collection("notes")
      .update(fx.timedId, { n: 999_999 });
  }
  if (params.part === "all" || params.part === "fold") {
    const tailLen = PRE_TAIL + (params.part === "all" ? 1 : 0);
    const options: InternalCompactOptions = {
      ...CLOUDFLARE_FREE_TIER.compact,
      minEntriesToCompact: 1,
      maxEntriesPerRun: Math.max(1, Math.min(params.entries, tailLen)),
      ceilingBytes: MAINTENANCE_MAX_FOLD_BYTES_DEFAULT,
      ceilingEntries: MAINTENANCE_MAX_FOLD_ROWS,
      knownTail: fx.logSeqStart + tailLen,
    };
    const r = await compact({ storage, currentJsonKey: KEY }, options);
    folded = r.entriesFolded;
    written = r.written;
    skipped = r.skippedReason;
  }
  return { cold, folded, written, skipped };
};

/**
 * The original factor subject, reconstructed: `loadSnapshotAsMap` ->
 * `foldChunkedSnapshotReference` over 2 KiB docs with `mutations` uniform
 * updates. Published factors: 6.89x (0.5 MiB) and 8.55x (1 MiB).
 */
export const runSubject = async (fx: Fixture, mutations: number) => {
  const { storage, cold } = await loadFixture(fx);
  const map = await loadSnapshotAsMap(storage, fx.snapshotKey!, "notes");
  const rows = [...map].map(([_id, body]) => ({ _id, body }));
  let seed = 777;
  const muts = Array.from({ length: mutations }, (_, i) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    const row = rows[seed % rows.length]!;
    return { op: "U" as const, doc_id: row._id, after: { ...row.body, n: 1000 + i } };
  });
  const out = foldChunkedSnapshotReference(rows, muts);
  return { cold, folded: muts.length, written: out.length === rows.length, skipped: undefined };
};
