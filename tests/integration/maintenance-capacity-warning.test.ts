/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes. */

/**
 * main-10 Task 5 (G7): the early capacity warning and the state it may touch,
 * on `memory` + `local-fs`, host SMALL (E = 20 rows, 5 entries per pass).
 *
 * - W1 an admitted write that leaves the collection at >= 90% of E carries
 *   the warning on the canonical line (`capacity_warning`) and, over HTTP, in
 *   the `Baerly-Capacity-Warning` header on POST, PATCH, PUT and DELETE; below
 *   90% it carries neither.
 * - W2 the warning is a pure function of head + tail: it clears after a
 *   shrink or a host change with nothing to reset, and returns when the state
 *   does.
 * - W3 a refused write persists nothing: `current.json` (every field,
 *   including `last_warned_seq` and `tail_hint`) and the bucket's keys are
 *   byte-for-byte unchanged, and it carries no warning.
 * - W4 crash around head transitions: a fold aborted at every K-th storage op
 *   leaves a head/tail the warning and the refusal read identically (the
 *   verdict follows the logical rows, not whichever head the crash left), and
 *   the refusal then clears once rows are deleted.
 * - W5 race: a fold landing between a request's `current.json` read and its
 *   decision changes neither verdict nor warning text; a peer's commit landing
 *   before the write's own is counted by the commit-time re-check.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  casUpdateCurrentJson,
  type Collection,
  MAINTENANCE_MIN_LIVE_BYTES,
  type Storage,
} from "@baerly/protocol";
import { Db } from "@baerly/server";
import { createRouter } from "@baerly/server/http";
import { runBoundedMaintenance } from "@baerly/server/_internal/maintenance";
import { createObservabilityContext, runWithContext } from "@baerly/server/observability";
import { abortingStorage } from "../fixtures/aborting-storage.ts";
import {
  commit,
  type Doc,
  drain,
  E,
  id,
  inserts,
  SMALL,
  state,
} from "../fixtures/fold-stall-harness.ts";
import {
  APP,
  bootstrap,
  COLLECTION,
  CURRENT_JSON_KEY,
  makeVariants,
  TENANT,
} from "../fixtures/maintenance-harness.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// W4 injects storage faults; the maintenance runner's operator-facing stack
// dump then fires once per injected abort. Correctness is asserted through
// the `expect(...)` invariants below, never through console output.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const WARNING_FIELD = "capacity_warning";
const WARNING_HEADER = "Baerly-Capacity-Warning";
const PAD = "x".repeat(20);

interface Host {
  maxFoldRows?: number;
}

/** What one request saw: its outcome and the warning stamped on its canonical-line fields. */
interface Seen {
  outcome: "accepted" | "capacity" | "backpressure" | "other";
  warning: string | undefined;
  error?: unknown;
}

const OUTCOME_BY_CODE: Record<string, Seen["outcome"]> = {
  CapacityExceeded: "capacity",
  MaintenancePending: "backpressure",
};

const hostCtx = (host: Host) =>
  createObservabilityContext({
    maintenance: {
      options: {
        profile: { ...SMALL, ...(host.maxFoldRows && { maxFoldRows: host.maxFoldRows }) },
      },
    },
  });

const collectionOn = (storage: Storage): Collection<Doc> =>
  Db.create({ storage, app: APP, tenant: TENANT }).collection(COLLECTION) as Collection<Doc>;

const run = async (
  storage: Storage,
  host: Host,
  write: (c: Collection<Doc>) => Promise<unknown>,
): Promise<Seen> => {
  const ctx = hostCtx(host);
  const warning = (): string | undefined => {
    const w = ctx.fields.get(WARNING_FIELD);
    return typeof w === "string" ? w : undefined;
  };
  try {
    await runWithContext(ctx, () => write(collectionOn(storage)));
    return { outcome: "accepted", warning: warning() };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    return {
      outcome: OUTCOME_BY_CODE[code ?? ""] ?? "other",
      warning: warning(),
      error,
    };
  }
};

const insertDoc = (i: number) => (c: Collection<Doc>) => c.insert({ _id: id(i), n: 0, pad: PAD });
/** Same-size update: admitted whatever the room, and adds no row to the projection. */
const touch = (i: number) => (c: Collection<Doc>) => c.update(id(i), { n: 1 });
const del = (i: number) => (c: Collection<Doc>) => c.delete(id(i));

const rawCurrent = async (storage: Storage): Promise<string> => {
  const got = await storage.get(CURRENT_JSON_KEY);
  return new TextDecoder().decode(got!.body as Uint8Array);
};

const keys = async (storage: Storage): Promise<string[]> => {
  const out: string[] = [];
  for await (const e of storage.list("")) {
    out.push(e.key);
  }
  return out.toSorted();
};

const VARIANTS = makeVariants("baerly-capacity-warning-");

describe("main-10 Task 5: early capacity warning and its state (G7)", () => {
  for (const variant of VARIANTS) {
    describe(variant.label, () => {
      let cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const c of cleanups) {
          await c();
        }
        cleanups = [];
      });

      const fresh = async (): Promise<Storage> => {
        const made = await variant.build();
        if (made.cleanup) {
          cleanups.push(made.cleanup);
        }
        await bootstrap(made.storage, "capacity-warning", MAINTENANCE_MIN_LIVE_BYTES);
        return made.storage;
      };

      /** `n` rows folded on SMALL, empty tail. */
      const folded = async (n: number): Promise<Storage> => {
        const storage = await fresh();
        await commit(storage, inserts(0, n, PAD));
        await drain(storage, SMALL);
        await expect(state(storage)).resolves.toMatchObject({ start: n, tail: n, rows: n });
        return storage;
      };

      /** `base` rows folded, then `extra` inserts left pending in the tail. */
      const withTail = async (base: number, extra: number): Promise<Storage> => {
        const storage = await folded(base);
        await commit(storage, inserts(base, base + extra, PAD));
        await expect(state(storage)).resolves.toMatchObject({ start: base, tail: base + extra });
        return storage;
      };

      test("W1: silent below 90% of E; from 90% the warning names the state and the app remedy only", async () => {
        const storage = await folded(15);
        // 16 and 17 rows (80%, 85%).
        for (const i of [15, 16]) {
          await expect(run(storage, {}, insertDoc(i))).resolves.toMatchObject({
            outcome: "accepted",
            warning: undefined,
          });
        }
        // 18 rows = 90%.
        const seen = await run(storage, {}, insertDoc(17));
        expect(seen.outcome).toBe("accepted");
        expect(seen.warning).toContain("18 of 20 rows");
        expect(seen.warning).toContain("baerly admin dump");
        expect(seen.warning).not.toMatch(/BAERLY_|PROFILE|profile|cf-paid|Paid/);
      });

      test("W1: over HTTP the write response carries the header; the body is unchanged", async () => {
        const storage = await folded(17);
        const router = createRouter({ db: Db.create({ storage, app: APP, tenant: TENANT }) });
        const post = (i: number) =>
          runWithContext(hostCtx({}), () =>
            router.request(`/v1/c/${COLLECTION}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ doc: { _id: id(i), n: 0, pad: PAD } }),
            }),
          );
        const warned = await post(17);
        expect(warned.status).toBe(201);
        await expect(warned.json()).resolves.toEqual({ _id: id(17) });
        expect(warned.headers.get(WARNING_HEADER)).toContain("18 of 20 rows");

        // PATCH and PUT carry it on their 200.
        const send = (method: "PATCH" | "PUT" | "DELETE", i: number, body?: unknown) =>
          runWithContext(hostCtx({}), () =>
            router.request(`/v1/c/${COLLECTION}/${id(i)}`, {
              method,
              ...(body !== undefined && {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
            }),
          );
        const patched = await send("PATCH", 0, { patch: { n: 1 } });
        expect(patched.status).toBe(200);
        expect(patched.headers.get(WARNING_HEADER)).toContain("18 of 20 rows");
        const replaced = await send("PUT", 0, { doc: { _id: id(0), n: 0, pad: PAD } });
        expect(replaced.status).toBe(200);
        expect(replaced.headers.get(WARNING_HEADER)).toContain("18 of 20 rows");

        // Reads never carry it.
        const read = await runWithContext(hostCtx({}), () =>
          router.request(`/v1/c/${COLLECTION}/${id(0)}`),
        );
        expect(read.headers.get(WARNING_HEADER)).toBeNull();

        // A refused write carries the refusal envelope, not a warning.
        await commit(storage, inserts(18, 19, PAD));
        const refused = await post(19);
        expect(refused.status).toBe(409);
        expect(refused.headers.get(WARNING_HEADER)).toBeNull();

        // DELETE carries it on its 204: the pending tail still peaks at 19 rows.
        const deleted = await send("DELETE", 18);
        expect(deleted.status).toBe(204);
        expect(deleted.headers.get(WARNING_HEADER)).toContain("19 of 20 rows");
      });

      test("W2: clears after a shrink and after a host change, with nothing to reset", async () => {
        const storage = await folded(17);
        const warnsNow = async (): Promise<boolean> => {
          const seen = await run(storage, {}, touch(0));
          expect(seen.outcome).toBe("accepted");
          return seen.warning !== undefined;
        };
        // 17 stored + 0 pending: a same-size update projects 17 rows = 85%.
        await commit(storage, inserts(17, 19, PAD));
        await expect(warnsNow()).resolves.toBe(true);

        // Host change: the identical bucket on a larger E is silent, then warns again on SMALL.
        const larger = await run(storage, { maxFoldRows: 4 * E }, touch(0));
        expect(larger).toMatchObject({ outcome: "accepted", warning: undefined });
        await expect(warnsNow()).resolves.toBe(true);

        // Shrink: delete rows and fold; no operator step, the warning is gone.
        for (const i of [0, 1, 2, 3, 4, 5, 6, 7]) {
          await expect(run(storage, {}, del(i))).resolves.toMatchObject({ outcome: "accepted" });
        }
        await drain(storage, SMALL);
        await expect(warnsNow()).resolves.toBe(false);
      });

      test("W2: a refusal clears the same way, and never needs a reset", async () => {
        const storage = await withTail(17, 2);
        await expect(run(storage, {}, insertDoc(30))).resolves.toMatchObject({
          outcome: "capacity",
        });
        // Larger host admits it (with its own warning state), SMALL refuses the next one again.
        await expect(run(storage, { maxFoldRows: 4 * E }, insertDoc(30))).resolves.toMatchObject({
          outcome: "accepted",
        });
        await expect(run(storage, {}, insertDoc(31))).resolves.toMatchObject({
          outcome: "capacity",
        });
        // Shrink on SMALL: deletes are admitted, the fold lands, growth is admitted again.
        for (const i of [0, 1, 2, 3, 4, 5]) {
          await run(storage, {}, del(i));
        }
        await drain(storage, SMALL);
        await expect(run(storage, {}, insertDoc(31))).resolves.toMatchObject({
          outcome: "accepted",
        });
      });

      test("W3: a refused write persists nothing, current.json bytes included, and carries no warning", async () => {
        const storage = await withTail(17, 2);
        const before = { head: await rawCurrent(storage), keys: await keys(storage) };
        const seen = await run(storage, {}, insertDoc(40));
        expect(seen).toMatchObject({ outcome: "capacity", warning: undefined });
        await expect(rawCurrent(storage)).resolves.toBe(before.head);
        await expect(keys(storage)).resolves.toEqual(before.keys);
      });

      test("W4: crash at every K-th op of a fold: the warning and the refusal read the same at every head", async () => {
        // 16 folded + 2 pending inserts = 18 logical rows. Folding the tail moves
        // the head from 16 to 18 stored rows; a decision read off the head alone
        // would see 16 rows (80%, no warning) at every crash point before it lands.
        const probe = async (storage: Storage) => run(storage, {}, touch(0));
        const baselineStorage = await withTail(16, 2);
        const baseline = await probe(baselineStorage);
        expect(baseline.outcome).toBe("accepted");
        expect(baseline.warning).toContain("18 of 20 rows");

        // Ops a clean fold issues, counted on a throwaway bucket.
        const counted = abortingStorage(await withTail(16, 2));
        const foldOnce = async (target: Storage): Promise<void> => {
          await runWithContext(createObservabilityContext({}), () =>
            runBoundedMaintenance(
              { storage: target, currentJsonKey: CURRENT_JSON_KEY, prevSeq: 18 },
              { profile: SMALL, minEntriesToCompact: 1, phasesPerTick: "single" },
            ),
          );
        };
        await casUpdateCurrentJson(counted.storage, CURRENT_JSON_KEY, (c) => ({
          ...c,
          mean_entry_bytes: Math.max(MAINTENANCE_MIN_LIVE_BYTES, c.snapshot_bytes),
        }));
        counted.resetCount();
        await foldOnce(counted.storage);
        const totalOps = counted.opCount();
        expect(totalOps).toBeGreaterThan(5);

        for (let k = 1; k <= totalOps + 1; k++) {
          const storage = await withTail(16, 2);
          const handle = abortingStorage(storage);
          await casUpdateCurrentJson(storage, CURRENT_JSON_KEY, (c) => ({
            ...c,
            mean_entry_bytes: Math.max(MAINTENANCE_MIN_LIVE_BYTES, c.snapshot_bytes),
          }));
          handle.resetCount();
          handle.armAt(k);
          await foldOnce(handle.storage).catch((error: unknown) => {
            expect((error as { name?: string }).name).toBe("AbortError");
          });

          // Admitted same-size write: same warning text whatever head the crash left.
          const seen = await probe(storage);
          expect(seen, `K=${k}`).toMatchObject({ outcome: "accepted" });
          expect(seen.warning, `K=${k}`).toBe(baseline.warning);

          // 18 + 1 = 19 rows is admitted; the next insert would reach E and is refused.
          const more = await run(storage, {}, insertDoc(60));
          expect(more.outcome, `K=${k}`).toBe("accepted");
          const refused = await run(storage, {}, insertDoc(61));
          expect(refused.outcome, `K=${k}`).toBe("capacity");

          // Shrink clears it, from whichever head the crash left.
          for (const i of [0, 1, 2, 3]) {
            await run(storage, {}, del(i));
          }
          await expect(run(storage, {}, insertDoc(61)), `K=${k}`).resolves.toMatchObject({
            outcome: "accepted",
          });
        }
      });

      test("W6: a write whose commit throws carries no warning", async () => {
        const storage = await folded(17);
        const failing: Storage = {
          get: (k, o) => storage.get(k, o),
          put: (k, b, o) => {
            if (k.includes("/log/")) {
              throw new Error("injected commit failure");
            }
            return storage.put(k, b, o);
          },
          delete: (k, o) => storage.delete(k, o),
          list: (p, o) => storage.list(p, o),
        } as Storage;
        const seen = await run(failing, {}, insertDoc(17));
        expect(seen.outcome).not.toBe("accepted");
        expect(seen.warning).toBeUndefined();
        // The same write on a healthy bucket does warn.
        const ok = await run(storage, {}, insertDoc(17));
        expect(ok.warning).toContain("18 of 20 rows");
      });

      test("W7: an update or delete that matches no rows writes nothing and does not warn", async () => {
        const storage = await folded(19);
        await expect(run(storage, {}, (c) => c.update(id(99), { n: 1 }))).resolves.toMatchObject({
          outcome: "accepted",
          warning: undefined,
        });
        await expect(run(storage, {}, del(99))).resolves.toMatchObject({
          outcome: "accepted",
          warning: undefined,
        });
        await expect(
          run(storage, {}, (c) => c.where({ n: 12345 }).update({ n: 2 })),
        ).resolves.toMatchObject({ outcome: "accepted", warning: undefined });
      });

      test("W5: a fold landing between the request's current.json read and its decision changes no verdict or text", async () => {
        const baseline = await run(await withTail(16, 2), {}, touch(0));
        expect(baseline.warning).toContain("18 of 20 rows");

        const storage = await withTail(16, 2);
        let fired = false;
        const racing: Storage = {
          ...storage,
          get: async (key, opts) => {
            const got = await storage.get(key, opts);
            if (key === CURRENT_JSON_KEY && !fired) {
              fired = true;
              // The fold lands right after this request read the head it will decide on.
              await drain(storage, SMALL);
            }
            return got;
          },
          put: (k, b, o) => storage.put(k, b, o),
          delete: (k, o) => storage.delete(k, o),
          list: (p, o) => storage.list(p, o),
        } as Storage;
        const seen = await run(racing, {}, touch(0));
        expect(fired).toBe(true);
        // The fold only moves the logical rows' home from tail to snapshot: the
        // request is admitted and carries the same text, never a retriable error.
        expect(seen.outcome).toBe("accepted");
        expect(seen.warning).toBe(baseline.warning);
      });

      test("W5: a peer's commit between a write's read and its commit brings the warning in at commit time", async () => {
        const storage = await folded(17);
        // At 17 rows (85%) a same-size update alone carries no warning.
        await expect(run(storage, {}, touch(0))).resolves.toMatchObject({ warning: undefined });
        let reads = 0;
        let fired = false;
        const racing: Storage = {
          ...storage,
          get: async (key, opts) => {
            // The writer's manifest read (the request's 2nd current.json read):
            // the decision is made, the commit not yet.
            if (key === CURRENT_JSON_KEY && ++reads === 2) {
              fired = true;
              await expect(run(storage, {}, insertDoc(17))).resolves.toMatchObject({
                outcome: "accepted",
              });
            }
            return await storage.get(key, opts);
          },
          put: (k, b, o) => storage.put(k, b, o),
          delete: (k, o) => storage.delete(k, o),
          list: (p, o) => storage.list(p, o),
        } as Storage;
        const seen = await run(racing, {}, touch(1));
        expect(fired).toBe(true);
        expect(seen.outcome).toBe("accepted");
        expect(seen.warning).toContain("18 of 20 rows");
      });
    });
  }
});
