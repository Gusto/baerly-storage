/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes. */

/**
 * main-10 Tasks 2–5: target behavior for growth refusal on a host that
 * cannot fold, on `memory` + `local-fs`. Rules (rows; bytes is the analogue
 * with C):
 *
 * - R1 row-exact fold: compact() folds the longest prefix whose rebuilt rows
 *   stay within E, so updates/deletes fold at E and only a row-adding entry
 *   at E stops it.
 * - R2 growth = insert or byte-growing update. Same-size and shrinking
 *   updates and deletes are not growth.
 * - R3 refuse growth iff the projected rows after folding the whole tail
 *   plus this write reach E.
 * - R4 no-progress state (`stored > E`, `stored_bytes > C`, or a pending
 *   row-adding entry the fold stops at with E rows): refuse every
 *   tail-appending write with the capacity code; reads stay served.
 * - R5 while the refusal condition holds, the in-band write tick bypasses
 *   the ratio trigger and the min-entries floor.
 * - R6 the decision is a pure function of head + tail; a refused write may
 *   change only `last_warned_seq`, `tail_hint` and real fold progress.
 *
 * `test.fails` cases encode the target and pass today only because their
 * target assertion fails; each names the rule whose landing flips it to
 * `test()`. Their preconditions are re-checked in-body with assertions that
 * hold today, and plain `test` cases pin them plus what must stay served.
 *
 * The host is what an adapter puts on the request's observability context:
 * `maintenance.options.profile`, plus `maintenance.maxFoldBytes` when
 * `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` is set. Probe writes use the public
 * `Collection` API under that context with default in-band options, and see
 * the compactor's real `mean_entry_bytes` stamp, so the ratio trigger is
 * closed whenever one runs.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type Collection,
  type CurrentJson,
  MAINTENANCE_MIN_LIVE_BYTES,
  MAINTENANCE_PROFILE_NODE,
  readCurrentJson,
  type Storage,
} from "@baerly/protocol";
import { Db } from "@baerly/server";
import type { MaintenanceProfile } from "@baerly/server/maintenance";
import { createObservabilityContext, runWithContext } from "@baerly/server/observability";
import {
  commit,
  type Doc,
  drain,
  E,
  id,
  inserts,
  PASS,
  readGets,
  type SeedOp,
  type Signals,
  SMALL,
  state,
  tick,
} from "../fixtures/fold-stall-harness.ts";
import {
  APP,
  bootstrap as bootstrapCurrentJson,
  COLLECTION,
  CURRENT_JSON_KEY,
  makeVariants,
  TENANT,
} from "../fixtures/maintenance-harness.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * The capacity code is never auto-retried. A refused write that advanced a
 * fold in that request may get the backpressure code instead (R5); with
 * nothing to fold, the capacity code is required.
 */
const CAPACITY_CODE = "CapacityExceeded";
const BACKPRESSURE_CODE = "MaintenancePending";
const isCapacityRefusal = (err: unknown): boolean => {
  const e = err as { code?: unknown; retriable?: unknown } | null;
  return e?.code === CAPACITY_CODE && e.retriable === false;
};
const isBackpressure = (err: unknown): boolean =>
  (err as { code?: unknown } | null)?.code === BACKPRESSURE_CODE;

/** `"accepted"`, `"capacity"`, `"backpressure"`, or the unexpected error itself. */
const outcome = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => "accepted",
    (error: unknown) => {
      if (isCapacityRefusal(error)) {
        return "capacity";
      }
      return isBackpressure(error) ? "backpressure" : error;
    },
  );

/** A serving host: its profile, plus the `C` override the adapters read from the env. */
interface Host {
  profile: MaintenanceProfile;
  maxFoldBytes?: number;
}
const SMALL_HOST: Host = { profile: SMALL };
const NODE_HOST: Host = { profile: MAINTENANCE_PROFILE_NODE };

/** Run `fn` against the public collection API as a request served by `host`. */
const onHost = async <R>(
  storage: Storage,
  host: Host,
  fn: (c: Collection<Doc>) => Promise<R>,
): Promise<R> =>
  await runWithContext(
    createObservabilityContext({
      maintenance: {
        options: { profile: host.profile },
        ...(host.maxFoldBytes !== undefined && { maxFoldBytes: host.maxFoldBytes }),
      },
    }),
    () =>
      fn(
        Db.create({ storage, app: APP, tenant: TENANT }).collection(COLLECTION) as Collection<Doc>,
      ),
  );

const tickOn = (
  storage: Storage,
  host: Host,
  opts: { signals?: Signals; restamp?: boolean } = {},
) =>
  tick(storage, host.profile, {
    ...opts,
    ...(host.maxFoldBytes !== undefined && { maxFoldBytes: host.maxFoldBytes }),
  });
const drainOn = (storage: Storage, host: Host) =>
  drain(storage, host.profile, {
    ...(host.maxFoldBytes !== undefined && { maxFoldBytes: host.maxFoldBytes }),
  });

const readIdsOn = (storage: Storage, host: Host): Promise<string[]> =>
  onHost(storage, host, async (c) => {
    const rows = await c.all();
    return rows.map((r) => r._id).toSorted();
  });

/** `current.json` minus the two fields a refused write may move (R6). */
const head = async (storage: Storage): Promise<Partial<CurrentJson>> => {
  const read = await readCurrentJson(storage, CURRENT_JSON_KEY);
  const { last_warned_seq: _warned, tail_hint: _hint, ...rest } = read!.json;
  return rest;
};

const keys = async (storage: Storage): Promise<string[]> => {
  const out: string[] = [];
  for await (const e of storage.list("")) {
    out.push(e.key);
  }
  return out.toSorted();
};

const ROW_PAD = "x".repeat(20);
/**
 * The bytes refusal margin is not decided yet (to be set by measurement).
 * Bytes fixtures stay valid for any margin up to this: 4 KiB is well above
 * any per-entry framing or estimate slack these 10-row fixtures could need.
 */
const ASSUMED_MAX_BYTES_MARGIN = 4096;
const M = ASSUMED_MAX_BYTES_MARGIN;
/** Bytes-fixture row pad: 10 rows give a ~80 KiB snapshot, far above M. */
const BYTE_ROW_PAD = "x".repeat(2 * M);
/** Growth probe: 3M of pad is past the 2M of headroom in "near" for any margin. */
const GROW_PAD = "x".repeat(3 * M);
/** Byte-growing update: a 2M row grows by 3M. */
const GROWN_ROW_PAD = "x".repeat(5 * M);
/** Small growth: M/4 of pad stays inside C - M from "near". */
const SMALL_PAD = "x".repeat(M / 4);
const doc = (i: number, pad = ROW_PAD): Doc => ({ _id: id(i), n: 0, pad });

type Write = (c: Collection<Doc>) => Promise<unknown>;
const insertW =
  (i: number, pad = ROW_PAD): Write =>
  (c) =>
    c.insert(doc(i, pad));
/** Same-size: `n` moves between single digits. */
const sameSizeW =
  (i: number, n = 1): Write =>
  (c) =>
    c.update(id(i), { n });
const shrinkW =
  (i: number): Write =>
  (c) =>
    c.update(id(i), { pad: "" });
const deleteW =
  (i: number): Write =>
  (c) =>
    c.delete(id(i));

/**
 * Run `write` on `host` and classify it. A refusal must be the capacity
 * code, or the backpressure code from a request that advanced the fold
 * (`log_seq_start` moved); backpressure with no fold, or any other error,
 * fails here.
 */
const attempt = async (
  storage: Storage,
  host: Host,
  write: Write,
): Promise<"accepted" | "refused"> => {
  const before = await state(storage);
  const result = await outcome(onHost(storage, host, write));
  if (result === "accepted") {
    return "accepted";
  }
  if (result === "backpressure") {
    const after = await state(storage);
    expect(after.start, "backpressure needs fold progress in that request").toBeGreaterThan(
      before.start,
    );
    return "refused";
  }
  expect(result).toBe("capacity");
  return "refused";
};

/**
 * One more write's fold cannot land on `host`: neither a tick under the real
 * stamp nor a re-stamped tick moves `log_seq_start`, and the re-stamped one
 * records a deferral. Seeds `growth` into `storage`, so pass a scenario
 * built only for this check.
 */
const expectHostCannotFoldGrowth = async (
  storage: Storage,
  host: Host,
  growth: SeedOp,
): Promise<void> => {
  await commit(storage, [growth]);
  const before = await state(storage);
  expect(before.tail).toBe(before.start + 1);

  await tickOn(storage, host, { restamp: false });
  await expect(state(storage)).resolves.toMatchObject({ start: before.start });

  const forced: Signals = { records: [] };
  await tickOn(storage, host, { signals: forced });
  await expect(state(storage)).resolves.toMatchObject({ start: before.start });
  expect(forced.records).toHaveLength(1);
};

/**
 * The write is refused and commits nothing: tail, live ids and bucket keys
 * unchanged, and `current.json` unchanged outside `last_warned_seq` /
 * `tail_hint`. Only for states with nothing a refused write could fold, so
 * the refusal must carry the capacity code.
 */
const expectRefusedAndInert = async (storage: Storage, host: Host, write: Write): Promise<void> => {
  const before = {
    state: await state(storage),
    head: await head(storage),
    keys: await keys(storage),
    ids: await readIdsOn(storage, host),
  };
  await expect(outcome(onHost(storage, host, write))).resolves.toBe("capacity");
  await expect(state(storage)).resolves.toMatchObject({
    start: before.state.start,
    tail: before.state.tail,
  });
  await expect(readIdsOn(storage, host)).resolves.toEqual(before.ids);
  await expect(keys(storage)).resolves.toEqual(before.keys);
  await expect(head(storage)).resolves.toEqual(before.head);
};

const VARIANTS = makeVariants("baerly-growth-refusal-");

describe("main-10: growth refusal (target behavior)", () => {
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
        await bootstrapCurrentJson(made.storage, "growth-refusal", MAINTENANCE_MIN_LIVE_BYTES);
        return made.storage;
      };

      /** `n` rows folded by `profile`, empty tail, real stamp. */
      const folded = async (n: number, profile: MaintenanceProfile): Promise<Storage> => {
        const storage = await fresh();
        await commit(storage, inserts(0, n, ROW_PAD));
        await drain(storage, profile);
        const s = await state(storage);
        expect(s).toMatchObject({ start: n, tail: n, rows: n });
        expect(s.mean).toBeLessThan(MAINTENANCE_MIN_LIVE_BYTES);
        return storage;
      };

      // ── Scenario builders ──────────────────────────────────────────

      /** Stored rows = E, reached with a 4-entry pass. Deletes still fold. */
      const atE = () => folded(E, { ...SMALL, maxFoldEntriesPerPass: 4 });
      /** No progress (R4): stored rows = E with a pending insert at the tail head. */
      const stalledAtE = async () => {
        const storage = await atE();
        await commit(storage, inserts(E, E + 1, ROW_PAD));
        await expect(state(storage)).resolves.toMatchObject({ start: E, tail: E + 1, rows: E });
        return storage;
      };
      /** No progress (R4): 26 rows folded on Node, served by SMALL. */
      const roundTrip = () => folded(26, MAINTENANCE_PROFILE_NODE);
      /** Refusal but progressable: stored 19 = E - 1, empty tail, so projected = E - 1. */
      const atEMinus1 = () => folded(E - 1, MAINTENANCE_PROFILE_NODE);
      /** Progressable, room for E - 1 - 16 = 3 more rows before projected = E. */
      const sixteen = () => folded(16, SMALL);

      /**
       * 10 padded rows folded; C set through the profile or the env override
       * (`BAERLY_MAINTENANCE_MAX_FOLD_BYTES` → `maintenance.maxFoldBytes`).
       * `"near"`: C = stored + 2M, progressable for any margin up to M, and a
       * 3M growth is past C for any margin. `"over"`: C = stored - M, no
       * progress (R4).
       */
      const bytesState = async (
        at: "near" | "over",
        via: "profile" | "env" = "profile",
      ): Promise<{ storage: Storage; host: Host }> => {
        const storage = await fresh();
        await commit(storage, inserts(0, 10, BYTE_ROW_PAD));
        await drain(storage, SMALL);
        const s = await state(storage);
        expect(s).toMatchObject({ start: 10, tail: 10, rows: 10 });
        expect(s.bytes).toBeGreaterThan(10 * 2 * M);
        expect(s.mean).toBeLessThan(MAINTENANCE_MIN_LIVE_BYTES);
        const c = at === "near" ? s.bytes + 2 * M : s.bytes - M;
        const host: Host =
          via === "profile"
            ? { profile: { ...SMALL, maxFoldBytes: c } }
            : { profile: SMALL, maxFoldBytes: c };
        return { storage, host };
      };

      // ── Preconditions (pass today, must keep passing) ──────────────
      describe("preconditions", () => {
        test("at E: an insert's fold defers on SMALL", async () => {
          await expectHostCannotFoldGrowth(await atE(), SMALL_HOST, {
            op: "I",
            i: E,
            pad: ROW_PAD,
          });
        });

        test("round trip: an insert's fold defers on SMALL after a Node-profile fold past E", async () => {
          await expectHostCannotFoldGrowth(await roundTrip(), SMALL_HOST, {
            op: "I",
            i: 26,
            pad: ROW_PAD,
          });
        });

        for (const via of ["profile", "env"] as const) {
          test(`bytes near C (via ${via}): an insert and a growing update each defer at the rebuild gate`, async () => {
            const a = await bytesState("near", via);
            await expectHostCannotFoldGrowth(a.storage, a.host, { op: "I", i: 10, pad: GROW_PAD });
            const b = await bytesState("near", via);
            await expectHostCannotFoldGrowth(b.storage, b.host, {
              op: "U",
              i: 0,
              pad: GROWN_ROW_PAD,
            });
          });
        }

        test("bytes over C: even a delete's fold defers (stored_bytes > C)", async () => {
          const { storage, host } = await bytesState("over");
          await expectHostCannotFoldGrowth(storage, host, { op: "D", i: 0 });
        });

        test("16 rows: an update-only tail's fold output fits E (E+1 folds it, rows unchanged)", async () => {
          const storage = await sixteen();
          await commit(
            storage,
            Array.from({ length: PASS }, (_, i) => ({
              op: "U" as const,
              i,
              pad: ROW_PAD.repeat(2),
            })),
          );
          await tick(storage, { ...SMALL, maxFoldRows: E + 1 });
          await expect(state(storage)).resolves.toMatchObject({ start: 21, tail: 21, rows: 16 });
        });
      });

      // ── Availability (pass today, must keep passing) ───────────────
      describe("availability", () => {
        const noProgress: Array<
          [string, () => Promise<{ storage: Storage; host: Host; live: number }>]
        > = [
          [
            "stalled at E",
            async () => ({ storage: await stalledAtE(), host: SMALL_HOST, live: E + 1 }),
          ],
          ["round trip", async () => ({ storage: await roundTrip(), host: SMALL_HOST, live: 26 })],
          ["bytes over C", async () => ({ ...(await bytesState("over")), live: 10 })],
        ];
        for (const [label, build] of noProgress) {
          test(`no progress (${label}): reads are served`, async () => {
            const { storage, host, live } = await build();
            await expect(readIdsOn(storage, host)).resolves.toHaveLength(live);
            await expect(onHost(storage, host, (c) => c.get(id(0)))).resolves.toMatchObject({
              _id: id(0),
            });
          });
        }

        const progressable: Array<
          [string, () => Promise<{ storage: Storage; host: Host; live: number }>]
        > = [
          ["E - 1", async () => ({ storage: await atEMinus1(), host: SMALL_HOST, live: E - 1 })],
          ["bytes near C", async () => ({ ...(await bytesState("near")), live: 10 })],
        ];
        for (const [label, build] of progressable) {
          test(`progressable (${label}): reads, a same-size update, a shrinking update and a delete are served`, async () => {
            const { storage, host, live } = await build();
            await expect(readIdsOn(storage, host)).resolves.toHaveLength(live);
            for (const w of [sameSizeW(0), shrinkW(1), deleteW(2)]) {
              await expect(outcome(onHost(storage, host, w))).resolves.toBe("accepted");
            }
            await expect(readIdsOn(storage, host)).resolves.toHaveLength(live - 1);
          });
        }

        // Accepted under every admission policy: projected <= E - PASS + 1 < E.
        test("inserts at stored rows <= E - PASS with an empty tail are accepted and fold on SMALL", async () => {
          const storage = await fresh();
          for (let i = 0; i <= E - PASS; i++) {
            await expect(state(storage)).resolves.toMatchObject({ start: i, tail: i, rows: i });
            await expect(outcome(onHost(storage, SMALL_HOST, insertW(i)))).resolves.toBe(
              "accepted",
            );
            await drain(storage, SMALL);
          }
          await expect(state(storage)).resolves.toMatchObject({
            start: E - PASS + 1,
            rows: E - PASS + 1,
          });
        });

        test("after a prefix peak of 25 > E drains on Node, SMALL accepts growth and folds it", async () => {
          const storage = await folded(10, SMALL);
          await commit(storage, inserts(10, 25, ROW_PAD));
          await commit(
            storage,
            Array.from({ length: 15 }, (_, i) => ({ op: "D" as const, i: 10 + i })),
          );
          await drain(storage, SMALL);
          // Today the fold stops at the 20-row prefix; a longer feasible
          // successor may fold further.
          const afterSmall = await state(storage);
          expect(afterSmall.tail).toBe(40);
          expect(afterSmall.start).toBeGreaterThanOrEqual(20);
          await drain(storage, MAINTENANCE_PROFILE_NODE);
          await expect(state(storage)).resolves.toMatchObject({ start: 40, tail: 40, rows: 10 });

          await expect(outcome(onHost(storage, SMALL_HOST, insertW(10)))).resolves.toBe("accepted");
          await drain(storage, SMALL);
          await expect(state(storage)).resolves.toMatchObject({ start: 41, tail: 41, rows: 11 });
        });
      });

      // ── R3: growth refusal (projected >= E) ────────────────────────
      describe("R3 growth refusal", () => {
        test("E - 1: an insert is refused and commits nothing", async () => {
          await expectRefusedAndInert(await atEMinus1(), SMALL_HOST, insertW(E - 1));
        });

        for (const via of ["profile", "env"] as const) {
          test(`bytes near C (via ${via}): an insert is refused and commits nothing`, async () => {
            const { storage, host } = await bytesState("near", via);
            await expectRefusedAndInert(storage, host, insertW(10, GROW_PAD));
          });
        }

        test("bytes near C: a byte-growing update is refused and commits nothing", async () => {
          const { storage, host } = await bytesState("near");
          await expectRefusedAndInert(storage, host, (c) =>
            c.update(id(0), { pad: GROWN_ROW_PAD }),
          );
        });

        test("pending tail: consecutive inserts from 16 rows, no drain, refuse exactly the one making projected = E", async () => {
          const storage = await sixteen();
          let accepted = 0;
          let refused = false;
          for (let k = 0; k < 10 && !refused; k++) {
            if ((await attempt(storage, SMALL_HOST, insertW(16 + k))) === "refused") {
              refused = true;
            } else {
              accepted++;
            }
          }
          expect(refused).toBe(true);
          expect(16 + accepted).toBe(E - 1);
          await expect(readIdsOn(storage, SMALL_HOST)).resolves.toHaveLength(E - 1);
        });

        test("reads stay bounded at the refusal point: 10 insert attempts from 16 rows add at most E - 1 - 16 read GETs", async () => {
          const storage = await sixteen();
          // A read GETs the snapshot plus one object per pending tail entry;
          // refusal caps pending growth at the 3 inserts that keep projected <= E - 1.
          const atEntry = await readGets(storage);
          for (let k = 0; k < 10; k++) {
            await attempt(storage, SMALL_HOST, insertW(16 + k));
          }
          await expect(readGets(storage)).resolves.toBeLessThanOrEqual(atEntry + (E - 1 - 16));
        });

        test("peak: from 14 rows, the insert making projected = E is refused; deletes then reopen growth", async () => {
          const storage = await folded(14, SMALL);
          for (let i = 14; i < E - 1; i++) {
            await expect(outcome(onHost(storage, SMALL_HOST, insertW(i)))).resolves.toBe(
              "accepted",
            );
          }
          await expect(readIdsOn(storage, SMALL_HOST)).resolves.toHaveLength(E - 1);
          await expect(attempt(storage, SMALL_HOST, insertW(E - 1))).resolves.toBe("refused");
          for (let i = 0; i < 6; i++) {
            await expect(outcome(onHost(storage, SMALL_HOST, deleteW(i)))).resolves.toBe(
              "accepted",
            );
          }
          await expect(outcome(onHost(storage, SMALL_HOST, insertW(E - 1)))).resolves.toBe(
            "accepted",
          );
          await expect(readIdsOn(storage, SMALL_HOST)).resolves.toHaveLength(E - 1 - 6 + 1);
        });

        test("peak over prefixes: a pending tail [6 inserts, 6 deletes] at 14 rows peaks at E, so growth is refused though the final projection is 15", async () => {
          const storage = await folded(14, SMALL);
          // Seeded without enforcement, as a larger host could have written it.
          await commit(storage, inserts(14, 20, ROW_PAD));
          await commit(
            storage,
            Array.from({ length: 6 }, (_, i) => ({ op: "D" as const, i: 14 + i })),
          );
          await expect(state(storage)).resolves.toMatchObject({ start: 14, tail: 26, rows: 14 });
          await expect(readIdsOn(storage, SMALL_HOST)).resolves.toHaveLength(14);
          await expect(attempt(storage, SMALL_HOST, insertW(E))).resolves.toBe("refused");
        });

        test("bytes peak over prefixes: near C, a pending tail [3M insert, its delete] peaks past C, so a small insert is refused though the final projection fits", async () => {
          const { storage, host } = await bytesState("near");
          // Seeded without enforcement, as a larger host could have written it.
          await commit(storage, [
            { op: "I", i: 10, pad: GROW_PAD },
            { op: "D", i: 10 },
          ]);
          await expect(state(storage)).resolves.toMatchObject({ start: 10, tail: 12, rows: 10 });
          await expect(readIdsOn(storage, host)).resolves.toHaveLength(10);
          // Final projection: stored + M/4, inside C - M for any margin up to M.
          await expect(attempt(storage, host, insertW(11, SMALL_PAD))).resolves.toBe("refused");
        });
      });

      // ── R4: no progress refuses every tail-appending write ─────────
      describe("R4 no-progress refusal", () => {
        // The next unused id in each state.
        const rowCases: Array<[string, () => Promise<Storage>, number]> = [
          ["stalled at E", stalledAtE, E + 1],
          ["round trip", roundTrip, 26],
        ];
        for (const [label, build, next] of rowCases) {
          const writes: Array<[string, Write]> = [
            ["an insert", insertW(next)],
            ["a delete", deleteW(0)],
            ["a shrinking update", shrinkW(0)],
            ["a same-size update", sameSizeW(0)],
          ];
          for (const [what, write] of writes) {
            test(`${label}: ${what} gets the capacity code and commits nothing`, async () => {
              await expectRefusedAndInert(await build(), SMALL_HOST, write);
            });
          }
        }

        for (const [what, write] of [
          ["an insert", insertW(10, GROW_PAD)],
          ["a delete", deleteW(0)],
          ["a shrinking update", shrinkW(0)],
          ["a same-size update", sameSizeW(0)],
        ] as const) {
          test(`bytes over C: ${what} gets the capacity code and commits nothing`, async () => {
            const { storage, host } = await bytesState("over");
            await expectRefusedAndInert(storage, host, write);
          });
        }
      });

      describe("at E with nothing pending (not R4)", () => {
        test("an insert gets the capacity code; deletes and same-size updates are accepted and fold in place", async () => {
          const storage = await atE();
          await expectRefusedAndInert(storage, SMALL_HOST, insertW(E));
          for (const w of [deleteW(0), sameSizeW(1), shrinkW(2)]) {
            await expect(outcome(onHost(storage, SMALL_HOST, w))).resolves.toBe("accepted");
          }
          await drain(storage, SMALL);
          await expect(state(storage)).resolves.toMatchObject({
            start: E + 3,
            tail: E + 3,
            rows: E - 1,
          });
        });
      });

      // ── R1: row-exact fold ─────────────────────────────────────────
      describe("R1 row-exact fold", () => {
        test("G2: byte-growing updates at 16 rows are accepted and their fold lands on SMALL", async () => {
          const storage = await sixteen();
          for (let i = 0; i < PASS; i++) {
            await expect(
              outcome(
                onHost(storage, SMALL_HOST, (c) => c.update(id(i), { pad: ROW_PAD.repeat(2) })),
              ),
            ).resolves.toBe("accepted");
          }
          await expect(state(storage)).resolves.toMatchObject({ start: 16, tail: 21 });
          await drain(storage, SMALL);
          await expect(state(storage)).resolves.toMatchObject({ start: 21, tail: 21, rows: 16 });
        });

        test("E - 2: a 5-entry delete-only tail folds fully on SMALL", async () => {
          const storage = await folded(E - 2, MAINTENANCE_PROFILE_NODE);
          await commit(
            storage,
            Array.from({ length: PASS }, (_, i) => ({ op: "D" as const, i })),
          );
          await expect(state(storage)).resolves.toMatchObject({ start: 18, tail: 23, rows: 18 });
          await drain(storage, SMALL);
          await expect(state(storage)).resolves.toMatchObject({ start: 23, tail: 23, rows: 13 });
        });

        test("E - 1: a same-size update is accepted and folds on SMALL", async () => {
          const storage = await atEMinus1();
          await expect(outcome(onHost(storage, SMALL_HOST, sameSizeW(0)))).resolves.toBe(
            "accepted",
          );
          await drain(storage, SMALL);
          await expect(state(storage)).resolves.toMatchObject({ start: E, tail: E, rows: E - 1 });
        });

        test("headroom: inserts one at a time on SMALL each drain fully; the first refused is the one making projected = E", async () => {
          const storage = await fresh();
          let refusedAt: number | undefined;
          for (let i = 0; i < 2 * E; i++) {
            // Drained before every insert: nothing to fold, so capacity code only.
            const result = await outcome(onHost(storage, SMALL_HOST, insertW(i)));
            if (result === "capacity") {
              refusedAt = i;
              break;
            }
            expect(result).toBe("accepted");
            await drain(storage, SMALL);
            const s = await state(storage);
            expect(s.start, `fold progress after accepted insert ${i}`).toBe(s.tail);
          }
          expect(refusedAt).toBe(E - 1);
        });
      });

      // ── Clearing: refusal lifts with no operator action ────────────
      describe("clearing", () => {
        test("E - 1: insert refused; deletes are accepted and fold; inserts are accepted again", async () => {
          const storage = await atEMinus1();
          await expect(outcome(onHost(storage, SMALL_HOST, insertW(E - 1)))).resolves.toBe(
            "capacity",
          );
          for (let i = 0; i < 3; i++) {
            await expect(outcome(onHost(storage, SMALL_HOST, deleteW(i)))).resolves.toBe(
              "accepted",
            );
          }
          await drain(storage, SMALL);
          await expect(state(storage)).resolves.toMatchObject({ start: 22, tail: 22, rows: 16 });
          await expect(outcome(onHost(storage, SMALL_HOST, insertW(E - 1)))).resolves.toBe(
            "accepted",
          );
          await drain(storage, SMALL);
          await expect(state(storage)).resolves.toMatchObject({ start: 23, tail: 23, rows: 17 });
        });

        test("bytes near C: insert refused; shrinking updates drain on the same host; growth is accepted again", async () => {
          const { storage, host } = await bytesState("near");
          await expect(outcome(onHost(storage, host, insertW(10, GROW_PAD)))).resolves.toBe(
            "capacity",
          );
          for (let i = 0; i < 10; i++) {
            await expect(outcome(onHost(storage, host, shrinkW(i)))).resolves.toBe("accepted");
          }
          await drainOn(storage, host);
          await expect(state(storage)).resolves.toMatchObject({ start: 20, tail: 20, rows: 10 });
          await expect(outcome(onHost(storage, host, insertW(10, GROW_PAD)))).resolves.toBe(
            "accepted",
          );
          await drainOn(storage, host);
          await expect(state(storage)).resolves.toMatchObject({ start: 21, tail: 21, rows: 11 });
        });

        // flip to test() when main-10 Task 5 lands — forced tick (R5)
        test.fails("in-band only: at E - 1, same-size updates fold through forced write ticks and the backlog stays bounded", async () => {
          const storage = await atEMinus1();
          const WRITES = 10;
          for (let k = 0; k < WRITES; k++) {
            await expect(outcome(onHost(storage, SMALL_HOST, sameSizeW(k)))).resolves.toBe(
              "accepted",
            );
          }
          // No cadence assumed: some fold lands within WRITES write ticks, so
          // the backlog ends below WRITES. Without a forced tick the ratio
          // trigger waits for ~MAINTENANCE_MIN_LIVE_BYTES / mean ≈ 300 entries
          // and nothing folds.
          const s = await state(storage);
          expect(s.start).toBeGreaterThan(E - 1);
          expect(s.tail - s.start).toBeLessThan(WRITES);
          expect(s.rows).toBe(E - 1);
        });

        // flip to test() when main-10 Task 5 lands — forced tick (R5) within the per-pass budget (R1)
        test.fails("per-pass budget: with k = PASS available, each forced write tick folds at most PASS entries, and some fold lands", async () => {
          const storage = await folded(10, SMALL);
          // 9 pending inserts: projected E - 1, so the refusal condition holds
          // and k = min(PASS, E - 10) = PASS.
          await commit(storage, inserts(10, E - 1, ROW_PAD));
          await expect(state(storage)).resolves.toMatchObject({ start: 10, tail: 19, rows: 10 });
          let progressed = 0;
          for (let k = 0; k < 3; k++) {
            const before = await state(storage);
            await expect(outcome(onHost(storage, SMALL_HOST, sameSizeW(k)))).resolves.toBe(
              "accepted",
            );
            const after = await state(storage);
            expect(after.start - before.start, `fold budget on write ${k}`).toBeLessThanOrEqual(
              PASS,
            );
            progressed += after.start - before.start;
          }
          expect(progressed).toBeGreaterThan(0);
        });

        test("host change: at E refused on SMALL; accepted under a larger E and on Node; back on SMALL every write is refused again, reads served", async () => {
          const storage = await atE();
          const keysBefore = await keys(storage);
          const headBefore = await head(storage);
          await expect(outcome(onHost(storage, SMALL_HOST, insertW(E)))).resolves.toBe("capacity");
          await expect(keys(storage)).resolves.toEqual(keysBefore);
          await expect(head(storage)).resolves.toEqual(headBefore);

          const largerE: Host = { profile: { ...SMALL, maxFoldRows: 2 * E } };
          await expect(outcome(onHost(storage, largerE, insertW(E)))).resolves.toBe("accepted");
          await drainOn(storage, largerE);
          await expect(state(storage)).resolves.toMatchObject({ start: E + 1, rows: E + 1 });
          await expect(outcome(onHost(storage, NODE_HOST, insertW(E + 1)))).resolves.toBe(
            "accepted",
          );

          await expect(outcome(onHost(storage, SMALL_HOST, insertW(E + 2)))).resolves.toBe(
            "capacity",
          );
          await expect(outcome(onHost(storage, SMALL_HOST, deleteW(0)))).resolves.toBe("capacity");
          await expect(readIdsOn(storage, SMALL_HOST)).resolves.toHaveLength(E + 2);
        });
      });
    });
  }
});
