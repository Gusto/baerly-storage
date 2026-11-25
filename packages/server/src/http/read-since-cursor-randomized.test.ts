/* eslint-disable no-underscore-dangle -- `_id` and `_meta` are the
   locked wire-shape field names. */

/**
 * Read-seeded `/v1/since` property: a subscriber that renders a
 * collection read and then polls from that read's `_meta.since_cursor`
 * sees every change committed after the state it read, each exactly
 * once and in order, under random interleavings of inserts, updates,
 * deletes, folds, log retirement, uncertified reclaims, reads and polls.
 * The seeding read is drawn from every read route: a list, a `.where()`
 * list, a count, and a by-id get that hits or misses (the miss is a 404
 * carrying the same `_meta`). The one other
 * outcome a poll may have is `CursorExpired`, and only when an entry the
 * cursor still needs is really gone; the subscriber then re-reads and
 * reseeds from the new read, as the React subscription pool does.
 *
 * Writes and a fold can land between a read and its first poll (the
 * window a separate `cursor=""` bootstrap request leaves open), inside a
 * list read after it has loaded `current.json`, and between a
 * long-poll's cycles. The state a read saw is recovered from its result
 * alone, never from its cursor: with nothing landing inside it, the read
 * saw the state after every commit so far, and checks its result
 * against it; a list read with inserts landing inside it matches exactly
 * one of the states in between. Everything goes through the router, so the cursor under test
 * is the one on the wire.
 *
 * The last case pins that the fixture discriminates: seeding from a
 * separate `cursor=""` poll instead fails the same checks.
 */

import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import {
  certifiedDeleteFloor,
  createCurrentJson,
  type DocumentData,
  type LogEntry,
  logObjectKey,
  logSeqStartOf,
  MemoryStorage,
  readCurrentJson,
  type Storage,
} from "@baerly/protocol";
import { logStateCurrentJson } from "../../../../tests/fixtures/log-state.ts";
import { PROP_TIMEOUT_MS } from "../_internal/randomized-model.ts";
import { compact } from "../compactor.ts";
import { Db } from "../db.ts";
import { retireLogRange } from "../log-retention.ts";
import { createObservabilityContext, runWithContext } from "../observability/context.ts";
import { createRouter } from "./router.ts";

const APP = "test";
const TENANT = "t";
const TABLE = "tickets";
const LOG_PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${TABLE}`;
const CURRENT_JSON_KEY = `${LOG_PREFIX}/current.json`;
const SUBSCRIBERS = 2;

/**
 * Where a subscriber's first poll starts: the read's `_meta.since_cursor`,
 * or a separate `cursor=""` poll issued after the read (the bootstrap the
 * read cursor replaces).
 */
type Seeding = "read-cursor" | "separate-poll";

/** The read a subscriber renders and seeds its poll from. */
type Read =
  | { readonly kind: "list" }
  | { readonly kind: "where" }
  | { readonly kind: "count" }
  | { readonly kind: "get"; readonly pick: number; readonly miss: boolean };

type Op =
  | { readonly kind: "insert"; readonly n: number }
  | { readonly kind: "update"; readonly pick: number }
  | { readonly kind: "delete"; readonly pick: number }
  | { readonly kind: "fold" }
  | { readonly kind: "retire"; readonly window: number }
  | { readonly kind: "sweep"; readonly n: number }
  /** (Re)join: read, then `n` writes and a fold before the first poll. */
  | { readonly kind: "join"; readonly sub: number; readonly n: number; readonly read: Read }
  /** (Re)join from a list read with `n` writes and a fold landing inside it. */
  | { readonly kind: "midJoin"; readonly sub: number; readonly n: number }
  | { readonly kind: "poll"; readonly sub: number }
  | { readonly kind: "midPoll"; readonly sub: number; readonly n: number };

const sub = fc.integer({ min: 0, max: SUBSCRIBERS - 1 });
const few = fc.integer({ min: 0, max: 2 });
const readArb: fc.Arbitrary<Read> = fc.oneof(
  fc.record({ kind: fc.constant("list" as const) }),
  fc.record({ kind: fc.constant("where" as const) }),
  fc.record({ kind: fc.constant("count" as const) }),
  fc.record({ kind: fc.constant("get" as const), pick: fc.nat(), miss: fc.boolean() }),
);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("insert" as const), n: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ kind: fc.constant("update" as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant("delete" as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant("fold" as const) }),
  fc.record({ kind: fc.constant("retire" as const), window: few }),
  fc.record({ kind: fc.constant("sweep" as const), n: fc.integer({ min: 1, max: 2 }) }),
  fc.record({ kind: fc.constant("join" as const), sub, n: few, read: readArb }),
  fc.record({ kind: fc.constant("midJoin" as const), sub, n: few }),
  fc.record({ kind: fc.constant("poll" as const), sub }),
  fc.record({ kind: fc.constant("midPoll" as const), sub, n: few }),
);

interface Subscriber {
  /** Unset until the subscriber has read and seeded its poll. */
  cursor: string | undefined;
  /** The state it holds: what its read saw, with every delivered change applied. */
  view: Map<string, DocumentData>;
  /** Next seq this subscriber must be handed. */
  next: number;
  /**
   * Its cursor was minted with no `current.json` to bind to, so it may
   * resume only while the floor is still 0.
   */
  unbound: boolean;
}

/** A row set in a canonical, comparable form. */
const canonical = (rows: Iterable<[string, DocumentData]>): string =>
  JSON.stringify([...rows].toSorted(([a], [b]) => (a < b ? -1 : 1)));

/** The `.where()` read: rows with an even `n`. */
const EVEN = { clauses: [{ op: "eq", field: "parity", value: 0 }] };
const LIST_READ: Read = { kind: "list" };

const run = async (opts: {
  readonly provisioned: boolean;
  readonly ops: readonly Op[];
  readonly seeding: Seeding;
}): Promise<void> => {
  const storage = new MemoryStorage();
  if (opts.provisioned) {
    await createCurrentJson(storage, CURRENT_JSON_KEY, logStateCurrentJson());
  }
  const db = Db.create({ storage, app: APP, tenant: TENANT });
  // Reads and polls go through a storage that runs `afterManifest`
  // once, right after the next `current.json` read returns, and
  // `beforeManifest` once, before the given-numbered one.
  let afterManifest: (() => Promise<void>) | undefined;
  let beforeManifest: { at: number; run: () => Promise<void> } | undefined;
  let manifestReads = 0;
  const serveStorage: Storage = {
    get: async (key, getOpts) => {
      if (key !== CURRENT_JSON_KEY) {
        return storage.get(key, getOpts);
      }
      manifestReads += 1;
      if (beforeManifest !== undefined && manifestReads === beforeManifest.at) {
        const { run: before } = beforeManifest;
        beforeManifest = undefined;
        await before();
      }
      const got = await storage.get(key, getOpts);
      if (afterManifest !== undefined) {
        const after = afterManifest;
        afterManifest = undefined;
        await after();
      }
      return got;
    },
    put: (key, body, putOpts) => storage.put(key, body, putOpts),
    delete: (key, delOpts) => storage.delete(key, delOpts),
    list: (prefix, listOpts) => storage.list(prefix, listOpts),
  };
  const app = createRouter({
    db: Db.create({ storage: serveStorage, app: APP, tenant: TENANT }),
    sinceTimeoutMs: 0,
    sincePollIntervalMs: 0,
  });
  const get = async (path: string): Promise<{ status: number; body: unknown }> => {
    const res = await app.fetch(new Request(`http://x${path}`));
    return { status: res.status, body: await res.json() };
  };

  // seq → the collection's rows once that commit landed (single writer,
  // so the n-th commit lands at seq n). `states[0]` is the empty state.
  const states: Array<ReadonlyMap<string, DocumentData>> = [new Map()];
  const truth = new Map<string, DocumentData>();
  const ctx = createObservabilityContext({ maintenance: { disabled: true } });
  const commits = (): number => states.length - 1;

  const landed = async (): Promise<void> => {
    const seq = commits();
    const stored = await storage.get(logObjectKey(LOG_PREFIX, seq));
    expect(stored, `commit ${seq} at its seq`).not.toBe(null);
    states.push(new Map(truth));
  };
  const insert = async (): Promise<void> => {
    const doc = { n: commits(), parity: commits() % 2 };
    const { _id } = await runWithContext(ctx, () => db.collection(TABLE).insert(doc));
    truth.set(_id, { ...doc, _id });
    await landed();
  };
  const update = async (pick: number): Promise<void> => {
    const ids = [...truth.keys()].toSorted();
    if (ids.length === 0) {
      return insert();
    }
    const id = ids[pick % ids.length]!;
    const last = commits();
    await runWithContext(ctx, () => db.collection(TABLE).update(id, { last }));
    truth.set(id, { ...truth.get(id)!, last });
    await landed();
  };
  const remove = async (pick: number): Promise<void> => {
    const ids = [...truth.keys()].toSorted();
    if (ids.length === 0) {
      return insert();
    }
    const id = ids[pick % ids.length]!;
    await runWithContext(ctx, () => db.collection(TABLE).delete(id));
    truth.delete(id);
    await landed();
  };
  const manifest = async () => {
    const read = await readCurrentJson(storage, CURRENT_JSON_KEY);
    return read?.json;
  };
  const fold = () =>
    compact({ storage, currentJsonKey: CURRENT_JSON_KEY }, { minEntriesToCompact: 1 });
  const writesThenFold = (n: number) => async (): Promise<void> => {
    for (let i = 0; i < n; i++) {
      await insert();
    }
    if (commits() > 0) {
      await fold();
    }
  };

  const subs: Subscriber[] = Array.from({ length: SUBSCRIBERS }, () => ({
    cursor: undefined,
    view: new Map(),
    next: 0,
    unbound: false,
  }));

  /** Apply a batch: each change exactly once, in order, from `sub.next`. */
  const deliver = (s: Subscriber, events: readonly LogEntry[]): void => {
    for (const event of events) {
      expect(event.seq, "no gap and no duplicate").toBe(s.next);
      if (event.op === "D") {
        s.view.delete(event.doc_id);
      } else {
        s.view.set(event.doc_id, event.after as DocumentData);
      }
      s.next += 1;
      expect(canonical(s.view), `view after seq ${event.seq}`).toBe(canonical(states[s.next]!));
    }
  };

  /** What `read` returns from `state`, in the shape the route sends. */
  const expected = (read: Read, state: ReadonlyMap<string, DocumentData>, id: string): unknown => {
    switch (read.kind) {
      case "list": {
        return canonical(state);
      }
      case "where": {
        return canonical([...state].filter(([, row]) => row["parity"] === 0));
      }
      case "count": {
        return state.size;
      }
      case "get": {
        return state.get(id);
      }
    }
  };

  /** Read the collection, recover the state it saw, and seed the poll. */
  const join = async (s: Subscriber, read: Read, between: () => Promise<void>): Promise<void> => {
    // Injected writes land after the read has loaded `current.json`.
    s.unbound = (await manifest()) === undefined;
    const before = commits();
    const ids = [...truth.keys()].toSorted();
    const id =
      read.kind === "get" && !read.miss && ids.length > 0
        ? ids[read.pick % ids.length]!
        : `missing-${before}`;
    const path = {
      list: `/v1/c/${TABLE}`,
      where: `/v1/c/${TABLE}?where=${encodeURIComponent(JSON.stringify(EVEN))}`,
      count: `/v1/count?collection=${TABLE}`,
      get: `/v1/c/${TABLE}/${encodeURIComponent(id)}`,
    }[read.kind];
    const res = await get(path);
    const body = res.body as {
      readonly data?: unknown;
      readonly _meta: { readonly since_cursor: string };
    };
    let got: unknown;
    if (read.kind === "get") {
      expect(res.status).toBe(ids.includes(id) ? 200 : 404);
      got = res.status === 200 ? body.data : undefined;
    } else {
      expect(res.status).toBe(200);
      got =
        read.kind === "count"
          ? (body.data as { count: number }).count
          : canonical((body.data as DocumentData[]).map((row) => [row["_id"] as string, row]));
    }
    // The state the read saw: the one its result matches among those
    // committed while it ran (only a list read has writes inside it).
    const matching: number[] = [];
    for (let seq = before; seq <= commits(); seq++) {
      if (JSON.stringify(expected(read, states[seq]!, id)) === JSON.stringify(got)) {
        matching.push(seq);
      }
    }
    expect(matching, "the read is a committed state").toHaveLength(1);
    s.next = matching[0]!;
    s.view = new Map(states[s.next]);
    await between();
    if (opts.seeding === "read-cursor") {
      s.cursor = body._meta.since_cursor;
      return;
    }
    // A separate bootstrap: its batch, if any, is delivered like any other.
    s.cursor = "";
    await poll(s);
  };

  /** One poll; `CursorExpired` re-joins, as the subscription pool does. */
  const poll = async (s: Subscriber): Promise<void> => {
    if (s.cursor === undefined) {
      return join(s, LIST_READ, async () => {});
    }
    const res = await get(`/v1/since?collection=${TABLE}&cursor=${encodeURIComponent(s.cursor)}`);
    if (res.status === 410) {
      expect((res.body as { error: { code: string } }).error.code).toBe("CursorExpired");
      // Legitimate only if an entry the subscriber still needs is gone.
      const current = await manifest();
      expect(current).toBeDefined();
      let gone =
        (s.unbound && logSeqStartOf(current!) > 0) || s.next < certifiedDeleteFloor(current!);
      for (let seq = s.next; !gone && seq < logSeqStartOf(current!); seq++) {
        gone = (await storage.get(logObjectKey(LOG_PREFIX, seq))) === null;
      }
      expect(gone, `CursorExpired at next=${s.next} with every needed entry retained`).toBe(true);
      return join(s, LIST_READ, async () => {});
    }
    expect(res.status).toBe(200);
    const batch = res.body as { readonly events: LogEntry[]; readonly next_cursor: string };
    deliver(s, batch.events);
    s.cursor = batch.next_cursor;
    // The poll's last cycle read the manifest that exists now, if any.
    s.unbound = (await manifest()) === undefined;
  };

  for (const op of opts.ops) {
    switch (op.kind) {
      case "insert": {
        for (let i = 0; i < op.n; i++) {
          await insert();
        }
        break;
      }
      case "update": {
        await update(op.pick);
        break;
      }
      case "delete": {
        await remove(op.pick);
        break;
      }
      case "fold": {
        await fold();
        break;
      }
      case "retire": {
        await retireLogRange(storage, CURRENT_JSON_KEY, { window: op.window });
        break;
      }
      case "sweep": {
        // An uncertified reclaim of the lowest folded objects, as a GC
        // sweep that has not recorded a delete floor leaves them.
        const current = await manifest();
        const floor = current === undefined ? 0 : logSeqStartOf(current);
        let removed = 0;
        for (let seq = 0; seq < floor && removed < op.n; seq++) {
          const key = logObjectKey(LOG_PREFIX, seq);
          if ((await storage.get(key)) !== null) {
            await storage.delete(key);
            removed += 1;
          }
        }
        break;
      }
      case "join": {
        await join(subs[op.sub]!, op.read, writesThenFold(op.n));
        break;
      }
      case "midJoin": {
        afterManifest = writesThenFold(op.n);
        await join(subs[op.sub]!, LIST_READ, async () => {});
        afterManifest = undefined;
        break;
      }
      case "poll": {
        await poll(subs[op.sub]!);
        break;
      }
      case "midPoll": {
        // After the long-poll's first cycle, before its next tick reads
        // the manifest.
        manifestReads = 0;
        beforeManifest = { at: 2, run: writesThenFold(op.n) };
        await poll(subs[op.sub]!);
        // A poll that delivered on its first cycle never ticked.
        beforeManifest = undefined;
        break;
      }
    }
  }

  // Drain: with nothing else happening, every subscriber reaches the
  // tail and shows the collection as it is.
  for (const s of subs) {
    for (
      let guard = 0;
      guard < commits() + 4 && (s.cursor === undefined || s.next < commits());
      guard++
    ) {
      await poll(s);
    }
    expect(s.next, "drained to the tail").toBe(commits());
    expect(canonical(s.view), "holds the collection as it is").toBe(canonical(truth));
  }
};

describe("read _meta.since_cursor — a seeded poll delivers what the read did not show", () => {
  fcTest.prop({
    provisioned: fc.boolean(),
    ops: fc.array(opArb, { minLength: 1, maxLength: 40 }),
  })(
    "each change after the read is delivered once, in order, or the poll is CursorExpired for a reclaimed entry",
    async ({ provisioned, ops }) => {
      await run({ provisioned, ops, seeding: "read-cursor" });
    },
    PROP_TIMEOUT_MS,
  );

  test('seeding from a separate cursor="" poll misses a write that commits and folds between the two requests', async () => {
    const ops: Op[] = [
      { kind: "insert", n: 1 },
      { kind: "join", sub: 0, n: 1, read: LIST_READ },
    ];
    await expect(run({ provisioned: true, ops, seeding: "separate-poll" })).rejects.toThrow(
      /drained to the tail/,
    );
    await expect(run({ provisioned: true, ops, seeding: "read-cursor" })).resolves.toBeUndefined();
  });
});
