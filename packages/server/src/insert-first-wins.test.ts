/**
 * First insert wins: of concurrent `insert`s of one `_id`, exactly one
 * commits and the others throw `AlreadyExists`.
 *
 * Two `Db`s share one `MemoryStorage` through per-`Db` gates, so a test can
 * park one insert at a chosen storage call while the other runs to
 * completion. Each schedule targets one part of the writer's insert guard:
 * the occupant readback after a lost create race, the pre-create window
 * check over entries a peer committed after the check read, and the GETs of
 * window slots a fold moved below `log_seq_start`.
 */

import {
  BaerlyError,
  decodeJsonBytes,
  type DocumentData,
  LOG_RETENTION_SEQ_WINDOW,
  type LogEntry,
  logObjectKey,
  MemoryStorage,
  readCurrentJson,
  type Storage,
  type StoragePutOptions,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { seedLogEntries } from "../../../tests/fixtures/log-state.ts";
import { compact } from "./compactor.ts";
import { Db } from "./db.ts";
import { retireLogRange } from "./log-retention.ts";
import { createObservabilityContext, runWithContext } from "./observability/index.ts";

const APP = "a";
const TENANT = "t";
const COLL = "c";
const PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;
const CURRENT_KEY = `${PREFIX}/current.json`;
const ID = "contested";

/** Write-tick maintenance off: the tests fold and retire explicitly. */
const MAINTENANCE_OFF = createObservabilityContext({ maintenance: { disabled: true } });

type Match = (op: "get" | "put", key: string, opts?: StoragePutOptions) => boolean;

interface Hold {
  /** Resolves when the matched call arrives (and is parked). */
  readonly reached: Promise<void>;
  /** Let the parked call through to the shared storage. */
  readonly release: () => void;
}

/**
 * A pass-through view of `inner` whose `hold(match)` parks the first call
 * `match` accepts until released.
 */
const gatedStorage = (inner: Storage): { storage: Storage; hold: (match: Match) => Hold } => {
  const holds: Array<{ match: Match; arrive: () => void; released: Promise<void> }> = [];
  const pass = async (op: "get" | "put", key: string, opts?: StoragePutOptions): Promise<void> => {
    const i = holds.findIndex((h) => h.match(op, key, opts));
    if (i < 0) {
      return;
    }
    const [h] = holds.splice(i, 1);
    h!.arrive();
    await h!.released;
  };
  const storage: Storage = {
    async get(key, opts) {
      await pass("get", key);
      return inner.get(key, opts);
    },
    async put(key, body, opts) {
      await pass("put", key, opts);
      return inner.put(key, body, opts);
    },
    delete: (key, opts) => inner.delete(key, opts),
    list: (prefix, opts) => inner.list(prefix, opts),
  };
  const hold = (match: Match): Hold => {
    let arrive!: () => void;
    const reached = new Promise<void>((r) => {
      arrive = r;
    });
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    holds.push({ match, arrive, released });
    return { reached, release };
  };
  return { storage, hold };
};

/** The N-th GET of `current.json` from now on (1-based). */
const nthCurrentJsonGet = (n: number): Match => {
  let seen = 0;
  return (op, key) => op === "get" && key === CURRENT_KEY && ++seen === n;
};

const logCreate: Match = (op, key, opts) =>
  op === "put" && /\/log\/\d+\.json$/.test(key) && opts?.ifNoneMatch === "*";

/** Every log entry still on the bucket for `ID`, in seq order. */
const entriesFor = async (storage: Storage): Promise<LogEntry[]> => {
  const out: LogEntry[] = [];
  for await (const item of storage.list(`${PREFIX}/log/`)) {
    const got = await storage.get(item.key);
    const entry = decodeJsonBytes<LogEntry>(got!.body);
    if (entry.doc_id === ID) {
      out.push(entry);
    }
  }
  return out.toSorted((x, y) => x.seq - y.seq);
};

const opsFor = async (storage: Storage): Promise<string[]> => {
  const entries = await entriesFor(storage);
  return entries.map((e) => e.op);
};

const setup = async (): Promise<{
  inner: MemoryStorage;
  a: Db;
  aGate: ReturnType<typeof gatedStorage>;
  b: Db;
}> => {
  const inner = new MemoryStorage();
  const aGate = gatedStorage(inner);
  const a = Db.create({ storage: aGate.storage, app: APP, tenant: TENANT });
  const b = Db.create({ storage: inner, app: APP, tenant: TENANT });
  // Provision the collection and put one unrelated row at seq 0, so B's
  // contested insert lands at seq 1.
  await runWithContext(MAINTENANCE_OFF, () => b.collection(COLL).insert({ _id: "seed" }));
  return { inner, a, aGate, b };
};

const insert = async (db: Db, body: DocumentData): Promise<{ _id: string }> =>
  await runWithContext(MAINTENANCE_OFF, () => db.collection(COLL).insert(body));

const rowOf = (storage: Storage): Promise<DocumentData | undefined> =>
  Db.create({ storage, app: APP, tenant: TENANT }).collection(COLL).get(ID);

describe("insert: the first I for an _id wins", () => {
  test("(i) a create that loses its slot to a peer's insert of the same _id throws AlreadyExists", async () => {
    const { inner, a, aGate, b } = await setup();
    const held = aGate.hold(logCreate);

    const pending = insert(a, { _id: ID, by: "A" });
    await held.reached;
    await expect(insert(b, { _id: ID, by: "B" })).resolves.toEqual({ _id: ID });
    held.release();

    const err = await pending.catch((error: unknown) => error);
    expect(err).toBeInstanceOf(BaerlyError);
    expect(err).toMatchObject({ code: "AlreadyExists", _id: ID });
    await expect(rowOf(inner)).resolves.toEqual({ _id: ID, by: "B" });
    await expect(opsFor(inner)).resolves.toEqual(["I"]);
  });

  test("(ii) a peer's insert committed after the check read is caught before the create", async () => {
    const { inner, a, aGate, b } = await setup();
    // GET #1 is runInsert's check read; GET #2 is the Writer's Step 1 read.
    const held = aGate.hold(nthCurrentJsonGet(2));

    const pending = insert(a, { _id: ID, by: "A" });
    await held.reached;
    await expect(insert(b, { _id: ID, by: "B" })).resolves.toEqual({ _id: ID });
    // A's tail probe now starts at B's entry, so A would create at the next
    // slot without any 412: only the pre-create window check can catch it.
    held.release();

    await expect(pending).rejects.toMatchObject({ code: "AlreadyExists", _id: ID });
    await expect(rowOf(inner)).resolves.toEqual({ _id: ID, by: "B" });
    await expect(opsFor(inner)).resolves.toEqual(["I"]);
  });

  test("(ii) identical caller-supplied bodies: one insert fulfils, the other throws AlreadyExists", async () => {
    const { inner, a, aGate, b } = await setup();
    const held = aGate.hold(nthCurrentJsonGet(2));
    const body = { _id: ID, title: "same" };

    const pending = insert(a, body);
    await held.reached;
    const first = insert(b, body);
    await first;
    held.release();

    const results = await Promise.allSettled([first, pending]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: "AlreadyExists" });
    await expect(rowOf(inner)).resolves.toEqual(body);
    await expect(opsFor(inner)).resolves.toEqual(["I"]);
  });

  test("(iii) a fold that moved log_seq_start past the check read's tail does not hide the peer's insert", async () => {
    const { inner, a, aGate, b } = await setup();
    const held = aGate.hold(nthCurrentJsonGet(2));

    const pending = insert(a, { _id: ID, by: "A" });
    await held.reached;
    await insert(b, { _id: ID, by: "B" });
    const folded = await compact(
      { storage: inner, currentJsonKey: CURRENT_KEY },
      { minEntriesToCompact: 1 },
    );
    // B's I sits at seq 1, which A's check read saw as the tail; the fold
    // moved the floor to 2.
    expect(folded).toMatchObject({ written: true, logSeqStartAfter: 2 });
    held.release();

    await expect(pending).rejects.toMatchObject({ code: "AlreadyExists", _id: ID });
    await expect(rowOf(inner)).resolves.toEqual({ _id: ID, by: "B" });
    await expect(opsFor(inner)).resolves.toEqual(["I"]);
  });

  test("(iii) retirement deleted part of the folded window: WriteConflict, nothing committed", async () => {
    const { inner, a, aGate, b } = await setup();
    const held = aGate.hold(nthCurrentJsonGet(2));

    const pending = insert(a, { _id: ID, by: "A" });
    await held.reached;
    await insert(b, { _id: ID, by: "B" });
    // Fill past the retention window so retirement may delete seqs 0 and 1,
    // B's I among them, after the fold absorbs them.
    const floor = LOG_RETENTION_SEQ_WINDOW + 2;
    await seedLogEntries(inner, PREFIX, 2, floor, () => ({ collection: COLL }));
    await expect(
      compact({ storage: inner, currentJsonKey: CURRENT_KEY }, { minEntriesToCompact: 1 }),
    ).resolves.toMatchObject({ written: true, logSeqStartAfter: floor });
    for (;;) {
      const { deleted } = await retireLogRange(inner, CURRENT_KEY);
      if (deleted === 0) {
        break;
      }
    }
    const head = await readCurrentJson(inner, CURRENT_KEY);
    expect(head?.json.log_delete_floor).toBe(2);
    await expect(inner.get(logObjectKey(PREFIX, 1))).resolves.toBeNull();
    held.release();

    const err = await pending.catch((error: unknown) => error);
    expect(err).toMatchObject({ code: "WriteConflict", retriable: true });
    // Nothing of A's landed: the row is still B's, read through the snapshot.
    await expect(rowOf(inner)).resolves.toEqual({ _id: ID, by: "B" });
    await expect(inner.get(logObjectKey(PREFIX, floor))).resolves.toBeNull();
  });

  test("an index on _id does not move the check read off the full fold", async () => {
    // On the index-walk path the read LISTs markers before it probes the
    // tail, so an insert landing between the two sits below the reported
    // tail without being folded. The insert check must not trust that tail.
    const inner = new MemoryStorage();
    const config = { collections: { [COLL]: { indexes: [{ name: "by_id", on: "_id" }] } } };
    const aGate = gatedStorage(inner);
    const a = Db.create({ storage: aGate.storage, app: APP, tenant: TENANT, config });
    const b = Db.create({ storage: inner, app: APP, tenant: TENANT, config });
    await insert(b, { _id: "seed" });
    const held = aGate.hold((op, key) => op === "get" && /\/log\/\d+\.json$/.test(key));

    const pending = insert(a, { _id: ID, by: "A" });
    await held.reached;
    await insert(b, { _id: ID, by: "B" });
    held.release();

    await expect(pending).rejects.toMatchObject({ code: "AlreadyExists", _id: ID });
    await expect(rowOf(inner)).resolves.toEqual({ _id: ID, by: "B" });
    await expect(opsFor(inner)).resolves.toEqual(["I"]);
  });

  test("an insert after a delete of the _id lands", async () => {
    const { inner, a, b } = await setup();
    await insert(b, { _id: ID, by: "B" });
    await runWithContext(MAINTENANCE_OFF, () => b.collection(COLL).delete(ID));
    await expect(insert(a, { _id: ID, by: "A" })).resolves.toEqual({ _id: ID });
    await expect(rowOf(inner)).resolves.toEqual({ _id: ID, by: "A" });
  });
});
