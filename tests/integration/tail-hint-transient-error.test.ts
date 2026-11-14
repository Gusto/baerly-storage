/**
 * `tail_hint` invariant under a transient storage error during tail
 * discovery: the error is not a tail. A failed GET mid forward-probe must
 * not be read as the first empty slot, so the failed pass publishes
 * nothing (`tail_hint`, `log_seq_start` and every other `current.json`
 * byte unchanged), and the next healthy pass probes from the stored
 * `max(log_seq_start, tail_hint)` rather than re-deriving from
 * `log_seq_start`, then lands `tail_hint` on the true tail.
 *
 * Covers every path that discovers the tail and can publish `tail_hint`:
 * `compact()` with an exact and a chunked probe, `runScheduledMaintenance`,
 * and `runBoundedMaintenance` without an `observedTail` (its scheduled
 * probe feeding the bounded refresh).
 */
import {
  BaerlyError,
  createCurrentJson,
  logObjectKey,
  MAINTENANCE_TAIL_HINT_REFRESH_WRITES,
  MemoryStorage,
  readCurrentJson,
  type Storage,
} from "@baerly/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { compact, type InternalCompactOptions } from "../../packages/server/src/compactor.ts";
import {
  runBoundedMaintenance,
  runScheduledMaintenance,
} from "../../packages/server/src/maintenance.ts";
import { logStateCurrentJson, seedLogEntries } from "../fixtures/log-state.ts";

const PREFIX = "app/a/tenant/t/manifests/c";
const KEY = `${PREFIX}/current.json`;
const FLOOR = 0;
const HINT = 10;
/** Far enough past the hint that the bounded refresh would publish. */
const TAIL = HINT + MAINTENANCE_TAIL_HINT_REFRESH_WRITES + 8;

/**
 * A `Storage` whose GET of `faultKey` fails once with a transient
 * `NetworkError` before reaching `inner`. Records every GET key.
 */
const transientGetFault = (inner: Storage, faultKey: string) => {
  let armed = true;
  const gets: string[] = [];
  const storage: Storage = {
    get: async (key, opts) => {
      gets.push(key);
      if (armed && key === faultKey) {
        armed = false;
        throw new BaerlyError("NetworkError", `injected transient GET failure at ${key}`);
      }
      return inner.get(key, opts);
    },
    put: (key, body, opts) => inner.put(key, body, opts),
    delete: (key, opts) => inner.delete(key, opts),
    list: (prefix, opts) => inner.list(prefix, opts),
  };
  return { storage, gets, disarm: () => (armed = false) };
};

type Path = {
  readonly name: string;
  /** Whether the transient error propagates out of this path. */
  readonly surfaces: boolean;
  readonly run: (storage: Storage) => Promise<unknown>;
};

const PATHS: readonly Path[] = [
  {
    name: "compact() with an exact probe",
    surfaces: true,
    run: (storage) => compact({ storage, currentJsonKey: KEY }, { minEntriesToCompact: 1 }),
  },
  {
    name: "compact() with a chunked probe",
    surfaces: true,
    run: (storage) =>
      compact({ storage, currentJsonKey: KEY }, {
        minEntriesToCompact: 1,
        maxTailProbeGets: TAIL - HINT + 1,
      } as InternalCompactOptions),
  },
  {
    name: "runScheduledMaintenance",
    surfaces: true,
    run: (storage) => runScheduledMaintenance({ storage, currentJsonKey: KEY }),
  },
  {
    name: "runBoundedMaintenance without an observed tail",
    surfaces: false,
    run: (storage) =>
      runBoundedMaintenance({ storage, currentJsonKey: KEY, prevSeq: HINT, disabled: true }),
  },
];

/** Probe slots to fault: first probed, mid-gap, last occupied, first empty. */
const FAULT_SEQS = [HINT, HINT + MAINTENANCE_TAIL_HINT_REFRESH_WRITES, TAIL - 1, TAIL] as const;

const firstLogGet = (gets: readonly string[]): string | undefined =>
  gets.find((key) => key.startsWith(`${PREFIX}/log/`));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tail_hint: a transient tail-probe error is not a tail", () => {
  for (const path of PATHS) {
    for (const faultSeq of FAULT_SEQS) {
      test(`${path.name}: a transient GET error at log/${faultSeq} publishes nothing, and the next pass probes from tail_hint`, async () => {
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const inner = new MemoryStorage();
        await createCurrentJson(
          inner,
          KEY,
          logStateCurrentJson({ tail_hint: HINT, log_seq_start: FLOOR }),
        );
        await seedLogEntries(inner, PREFIX, FLOOR, TAIL);
        const before = await inner.get(KEY);

        const faulty = transientGetFault(inner, logObjectKey(PREFIX, faultSeq));
        const outcome = await path.run(faulty.storage).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        expect(faulty.gets).toContain(logObjectKey(PREFIX, faultSeq));
        if (path.surfaces) {
          expect(outcome.ok).toBe(false);
          expect(!outcome.ok && (outcome.error as BaerlyError).code).toBe("NetworkError");
        } else {
          expect(outcome.ok).toBe(true);
          expect(errors).toHaveBeenCalledTimes(1);
        }
        const afterFault = await inner.get(KEY);
        expect(new TextDecoder().decode(afterFault!.body)).toBe(
          new TextDecoder().decode(before!.body),
        );

        faulty.disarm();
        faulty.gets.length = 0;
        await path.run(faulty.storage);
        expect(firstLogGet(faulty.gets)).toBe(logObjectKey(PREFIX, HINT));
        const healed = (await readCurrentJson(inner, KEY))!.json;
        expect(healed.tail_hint).toBe(TAIL);
        expect(healed.log_seq_start).toBeGreaterThanOrEqual(FLOOR);
      });
    }
  }
});
