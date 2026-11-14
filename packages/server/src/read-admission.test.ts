/**
 * Unit tests for the request-bound parts of read admission: the head
 * check against the request ledger, and the forward-probe cap the ledger
 * sets (`forwardProbeCap` / `probeReadTail`). The data bounds are covered
 * end to end in `tests/integration/read-admission.test.ts`.
 */

import {
  BaerlyError,
  CODE_RESOLUTIONS,
  LOG_FORWARD_PROBE_CAP,
  MemoryStorage,
  RequestLedger,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { logStateCurrentJson, seedLogEntries } from "../../../tests/fixtures/log-state.ts";
import { forwardProbeCap, probeReadTail } from "./log-tail.ts";
import { createObservabilityContext, runWithContext } from "./observability/context.ts";
import { ReadBudget } from "./read-admission.ts";

const PREFIX = "app/t/tenant/x/manifests/c";

const underLedger = <T>(limit: number, fn: () => T | Promise<T>): T | Promise<T> =>
  runWithContext(
    createObservabilityContext({ ledger: new RequestLedger({ internal: limit, external: limit }) }),
    fn,
  );

const capacityRefusal = (err: unknown): void => {
  expect(err).toBeInstanceOf(BaerlyError);
  expect((err as BaerlyError).code).toBe("CapacityExceeded");
  expect((err as BaerlyError).retriable).toBe(false);
};

describe("ReadBudget.admitHead against the request ledger", () => {
  // snapshot GET + 10 strict entries + the probe's empty slot = 12 calls at least.
  const head = logStateCurrentJson({
    snapshot: `${PREFIX}/snapshot/L0/0-4-abc.json`,
    log_seq_start: 5,
    tail_hint: 15,
    snapshot_rows: 5,
    snapshot_bytes: 100,
  });

  test("refuses when the certain minimum is more than the ledger has left", () => {
    underLedger(11, () => {
      let caught: unknown;
      try {
        new ReadBudget("c", {}).admitHead(head);
      } catch (error) {
        caught = error;
      }
      capacityRefusal(caught);
    });
  });

  test("admits when the minimum fits exactly", () => {
    underLedger(12, () => {
      expect(() => new ReadBudget("c", {}).admitHead(head)).not.toThrow();
    });
  });

  test("the pool the envelope names sizes the check", () => {
    const ledger = new RequestLedger({ internal: 100, external: 3 });
    runWithContext(createObservabilityContext({ ledger }), () => {
      expect(() => new ReadBudget("c", { requestPool: "internal" }).admitHead(head)).not.toThrow();
      expect(() => new ReadBudget("c", { requestPool: "external" }).admitHead(head)).toThrow(
        BaerlyError,
      );
    });
  });
});

describe("forwardProbeCap / probeReadTail", () => {
  test("without a ledger the runaway cap applies", () => {
    expect(forwardProbeCap()).toEqual({ slots: LOG_FORWARD_PROBE_CAP, bound: "runaway" });
  });

  test("an unlimited ledger keeps the runaway cap", () => {
    runWithContext(createObservabilityContext({ ledger: new RequestLedger() }), () => {
      expect(forwardProbeCap()).toEqual({ slots: LOG_FORWARD_PROBE_CAP, bound: "runaway" });
    });
  });

  test("a ledger with less left than the runaway cap sets the cap", () => {
    underLedger(7, () => {
      expect(forwardProbeCap()).toEqual({ slots: 7, bound: "request" });
    });
  });

  test("a probe that exhausts a ledger-set cap is a capacity refusal", async () => {
    const storage = new MemoryStorage();
    await seedLogEntries(storage, PREFIX, 0, 5);
    const refusal = (): BaerlyError =>
      new BaerlyError("CapacityExceeded", "probe ran out of request budget");
    await underLedger(5, async () => {
      // Five occupied slots and no room for the sixth, empty one.
      await expect(probeReadTail(storage, PREFIX, 0, { refusal })).rejects.toSatisfy((err) => {
        capacityRefusal(err);
        return true;
      });
    });
    await underLedger(6, async () => {
      await expect(probeReadTail(storage, PREFIX, 0, { refusal })).resolves.toMatchObject({
        tail: 5,
      });
    });
  });

  test("onBody sees each stored body before decode and can stop the probe", async () => {
    const storage = new MemoryStorage();
    await seedLogEntries(storage, PREFIX, 0, 3);
    const seen: number[] = [];
    const stop = new BaerlyError("CapacityExceeded", "stop");
    await expect(
      probeReadTail(storage, PREFIX, 0, {
        refusal: () => stop,
        onBody: (bytes) => {
          seen.push(bytes);
          if (seen.length === 2) {
            throw stop;
          }
        },
      }),
    ).rejects.toBe(stop);
    expect(seen).toHaveLength(2);
    expect(seen.every((n) => n > 0)).toBe(true);
  });
});

describe("read refusal resolution", () => {
  const head = logStateCurrentJson({
    snapshot: `${PREFIX}/snapshot/L0/0-4-abc.json`,
    log_seq_start: 5,
    tail_hint: 5,
    snapshot_rows: 5,
    snapshot_bytes: 100,
  });

  const refusalOf = (fn: () => void): BaerlyError => {
    try {
      fn();
    } catch (error) {
      capacityRefusal(error);
      return error as BaerlyError;
    }
    throw new Error("expected a refusal");
  };

  // One refusal per bound family. The write remedy (delete or shrink rows
  // to make room for growth) is wrong for a read; each read refusal names
  // its own bound's remedy instead.
  const refusals = {
    output: () => refusalOf(() => new ReadBudget("c", { maxOutputRows: 1 }).admitOutput(2)),
    snapshot: () => refusalOf(() => new ReadBudget("c", { maxSnapshotRows: 1 }).admitHead(head)),
    tail: () => refusalOf(() => new ReadBudget("c", { maxTailEntries: 0 }).chargeTailBody(10)),
    materialized: () =>
      refusalOf(() => new ReadBudget("c", { maxMaterializedRows: 1 }).admitHead(head)),
  };

  test("each bound passes its own remedy as the resolution, not the write remedy", () => {
    const resolutions = Object.fromEntries(
      Object.entries(refusals).map(([name, refuse]) => [name, refuse().resolution]),
    );
    for (const resolution of Object.values(resolutions)) {
      expect(resolution).toBeTypeOf("string");
      expect(resolution).not.toBe(CODE_RESOLUTIONS.CapacityExceeded);
      expect(resolution).not.toMatch(/BAERLY_|PROFILE|cf-paid|cf-free|wrangler/);
    }
    expect(resolutions["output"]).toMatch(/narrow the predicate or add a limit/i);
    expect(resolutions["snapshot"]).toMatch(/delete or shrink rows/i);
    expect(resolutions["tail"]).not.toBe(resolutions["snapshot"]);
    expect(resolutions["tail"]).not.toBe(resolutions["output"]);
  });

  test("the resolution is the remedy the message closes with", () => {
    for (const refuse of Object.values(refusals)) {
      const err = refuse();
      expect(err.message.endsWith(err.resolution!)).toBe(true);
    }
  });
});
