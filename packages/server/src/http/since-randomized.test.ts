/**
 * `/v1/since` resume property: under random interleavings of writes,
 * folds, log retirement, `restore --force` reseeds and polls, every subscriber's batches,
 * concatenated across resumes, are the log suffix from where it joined:
 * each entry exactly once, in order, with no gap. The one other outcome
 * a poll may have is `CursorExpired`, and only when an entry the cursor
 * still needs is really gone, or its generation was replaced, or it was
 * minted before any manifest existed and the floor has left 0; the
 * subscriber then re-joins with `""`
 * and the check restarts from the floor it rejoined at.
 *
 * The collection starts empty, provisioned or not, so subscribers also
 * join before the first commit. A `midPoll` poll lets writes and a fold
 * land between a long-poll's first cycle and its next tick.
 */

import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import {
  BaerlyError,
  certifiedDeleteFloor,
  createCurrentJson,
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
import { longPollSince } from "./since.ts";

const APP = "test";
const TENANT = "t";
const TABLE = "tickets";
const LOG_PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${TABLE}`;
const CURRENT_JSON_KEY = `${LOG_PREFIX}/current.json`;
const SUBSCRIBERS = 2;

type Op =
  | { readonly kind: "write"; readonly n: number }
  | { readonly kind: "fold" }
  | { readonly kind: "retire"; readonly window: number }
  | { readonly kind: "sweep"; readonly n: number }
  | { readonly kind: "restore" }
  | { readonly kind: "poll"; readonly sub: number }
  | { readonly kind: "midPoll"; readonly sub: number; readonly n: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("write" as const), n: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ kind: fc.constant("fold" as const) }),
  fc.record({ kind: fc.constant("retire" as const), window: fc.integer({ min: 0, max: 2 }) }),
  fc.record({ kind: fc.constant("sweep" as const), n: fc.integer({ min: 1, max: 2 }) }),
  fc.record({ kind: fc.constant("restore" as const) }),
  fc.record({
    kind: fc.constant("poll" as const),
    sub: fc.integer({ min: 0, max: SUBSCRIBERS - 1 }),
  }),
  fc.record({
    kind: fc.constant("midPoll" as const),
    sub: fc.integer({ min: 0, max: SUBSCRIBERS - 1 }),
    n: fc.integer({ min: 0, max: 2 }),
  }),
);

interface Subscriber {
  cursor: string;
  /** First seq of the current segment: the floor at its `""` join. */
  segmentStart: number | undefined;
  /** Generation of the manifest its last successful poll saw, if any. */
  generation: string | undefined;
  /** Next seq this subscriber must be handed. */
  next: number;
}

describe("/v1/since — resumes deliver the log suffix exactly once", () => {
  fcTest.prop({
    provisioned: fc.boolean(),
    ops: fc.array(opArb, { minLength: 1, maxLength: 40 }),
  })(
    "batches across resumes equal the log suffix, or the poll is CursorExpired for a reclaimed entry",
    async ({ provisioned, ops }) => {
      const storage = new MemoryStorage();
      if (provisioned) {
        await createCurrentJson(storage, CURRENT_JSON_KEY, logStateCurrentJson());
      }
      const db = Db.create({ storage, app: APP, tenant: TENANT });
      // Polls go through a storage that can run `between` once, on a
      // poll's second `current.json` read: after its first cycle,
      // before its next tick reads the manifest.
      let between: (() => Promise<void>) | undefined;
      let manifestReads = 0;
      const pollStorage: Storage = {
        get: async (key, opts) => {
          if (key === CURRENT_JSON_KEY && between !== undefined && ++manifestReads === 2) {
            const run = between;
            between = undefined;
            await run();
          }
          return storage.get(key, opts);
        },
        put: (key, body, opts) => storage.put(key, body, opts),
        delete: (key, opts) => storage.delete(key, opts),
        list: (prefix, opts) => storage.list(prefix, opts),
      };
      const pollDb = Db.create({ storage: pollStorage, app: APP, tenant: TENANT });
      // seq → lsn of every committed entry, recorded at commit time
      // (single writer, so the n-th commit lands at seq n).
      const lsns: string[] = [];
      // seq → the generation it was committed in.
      const generations: Array<string | undefined> = [];
      const ctx = createObservabilityContext({ maintenance: { disabled: true } });

      const write = async (): Promise<void> => {
        await runWithContext(ctx, () => db.collection(TABLE).insert({ n: lsns.length }));
        const got = await storage.get(logObjectKey(LOG_PREFIX, lsns.length));
        expect(got, `commit ${lsns.length} landed at its seq`).not.toBeNull();
        lsns.push((JSON.parse(new TextDecoder().decode(got!.body)) as { lsn: string }).lsn);
        const committedIn = await manifest();
        generations.push(committedIn?.generation);
      };

      const manifest = async () => {
        const read = await readCurrentJson(storage, CURRENT_JSON_KEY);
        return read?.json;
      };
      const fold = () =>
        compact({ storage, currentJsonKey: CURRENT_JSON_KEY }, { minEntriesToCompact: 1 });

      const subs: Subscriber[] = Array.from({ length: SUBSCRIBERS }, () => ({
        cursor: "",
        segmentStart: undefined,
        next: 0,
        generation: undefined,
      }));

      /** One poll; returns whether it delivered anything. */
      const poll = async (sub: Subscriber): Promise<boolean> => {
        const before = await manifest();
        const floor = before === undefined ? 0 : logSeqStartOf(before);
        // Joining: `""` starts at the floor. A subscriber handed `""`
        // back later has not re-joined, so its next entry stays put.
        if (sub.segmentStart === undefined) {
          sub.segmentStart = floor;
          sub.next = floor;
        }
        let res;
        try {
          res = await longPollSince({
            db: pollDb,
            collection: TABLE,
            cursor: sub.cursor,
            timeoutMs: 0,
            pollIntervalMs: 0,
          });
        } catch (error) {
          expect(error).toBeInstanceOf(BaerlyError);
          expect((error as BaerlyError).code).toBe("CursorExpired");
          // Legitimate only if an entry the subscriber still needs is gone.
          const current = await manifest();
          expect(current).toBeDefined();
          // A restore retires every cursor of the generation it replaced,
          // and a cursor minted before any manifest existed resumes only
          // at floor 0.
          const regenerated =
            sub.generation === undefined
              ? logSeqStartOf(current!) > 0
              : sub.generation !== current!.generation;
          let gone = regenerated || sub.next < certifiedDeleteFloor(current!);
          for (let s = sub.next; !gone && s < logSeqStartOf(current!); s++) {
            gone = (await storage.get(logObjectKey(LOG_PREFIX, s))) === null;
          }
          expect(gone, `CursorExpired at next=${sub.next} with every needed entry retained`).toBe(
            true,
          );
          sub.cursor = "";
          sub.segmentStart = undefined;
          return false;
        }
        const seen = await manifest();
        for (const event of res.events) {
          expect(event.seq, "no gap and no duplicate").toBe(sub.next);
          expect(event.lsn).toBe(lsns[event.seq]);
          expect(generations[event.seq], "no entry from a replaced generation").toBe(
            seen?.generation,
          );
          sub.next += 1;
        }
        sub.cursor = res.next_cursor;
        sub.generation = seen?.generation;
        return res.events.length > 0;
      };

      let restores = 0;
      for (const op of ops) {
        if (op.kind === "write") {
          for (let i = 0; i < op.n; i++) {
            await write();
          }
        } else if (op.kind === "fold") {
          await fold();
        } else if (op.kind === "retire") {
          await retireLogRange(storage, CURRENT_JSON_KEY, { window: op.window });
        } else if (op.kind === "sweep") {
          // An uncertified reclaim of the lowest folded objects, as a GC
          // sweep that has not recorded a delete floor leaves them.
          const current = await manifest();
          const floor = current === undefined ? 0 : logSeqStartOf(current);
          let removed = 0;
          for (let s = 0; s < floor && removed < op.n; s++) {
            const key = logObjectKey(LOG_PREFIX, s);
            if ((await storage.get(key)) !== null) {
              await storage.delete(key);
              removed += 1;
            }
          }
        } else if (op.kind === "restore") {
          // `restore --force`: a new generation, reseeded one past the
          // surviving log objects, which stay behind as leftovers.
          const current = await manifest();
          if (current !== undefined) {
            restores += 1;
            const reseeded = {
              ...current,
              snapshot: null,
              snapshot_bytes: 0,
              snapshot_rows: 0,
              tail_hint: lsns.length,
              log_seq_start: lsns.length,
              log_delete_floor: undefined,
              generation: (0xabc000000000 + restores).toString(16),
            };
            await storage.put(CURRENT_JSON_KEY, new TextEncoder().encode(JSON.stringify(reseeded)));
          }
        } else if (op.kind === "poll") {
          await poll(subs[op.sub]!);
        } else {
          manifestReads = 0;
          between = async () => {
            for (let i = 0; i < op.n; i++) {
              await write();
            }
            if (lsns.length > 0) {
              await fold();
            }
          };
          await poll(subs[op.sub]!);
          // A poll that delivered on its first cycle never ticked.
          between = undefined;
        }
      }

      // Drain: with nothing else happening, each subscriber reaches the
      // tail (re-joining at most once if its cursor was reclaimed).
      for (const sub of subs) {
        for (let guard = 0; guard < lsns.length + 4; guard++) {
          const delivered = await poll(sub);
          if (!delivered && sub.segmentStart !== undefined && sub.next === lsns.length) {
            break;
          }
        }
        expect(sub.segmentStart).toBeDefined();
        expect(sub.next, "drained to the tail").toBe(lsns.length);
      }
    },
    PROP_TIMEOUT_MS,
  );
});
