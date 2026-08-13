import { type CurrentJson, LOG_RETENTION_SEQ_WINDOW } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { logStateCurrentJson } from "../../../tests/fixtures/log-state.ts";
import { computeRetirableRange } from "./log-retention.ts";

const cur = (logSeqStart: number, logDeleteFloor?: number): CurrentJson =>
  logStateCurrentJson({
    tail_hint: logSeqStart + 1000,
    log_seq_start: logSeqStart,
    ...(logDeleteFloor !== undefined && { log_delete_floor: logDeleteFloor }),
  });

describe("computeRetirableRange", () => {
  test("is empty when the floor has not cleared the window", () => {
    expect(computeRetirableRange(cur(100), { window: 500, maxDeletes: 20 })).toEqual({
      start: 0,
      end: 0,
    });
  });

  test("retires from the delete floor up to the per-pass budget", () => {
    expect(computeRetirableRange(cur(1000, 400), { window: 500, maxDeletes: 20 })).toEqual({
      start: 400,
      end: 420,
    });
  });

  test("clamps the end to the window boundary", () => {
    expect(computeRetirableRange(cur(1000, 495), { window: 500, maxDeletes: 20 })).toEqual({
      start: 495,
      end: 500,
    });
  });

  test("is empty when a raised window falls behind the delete floor", () => {
    expect(computeRetirableRange(cur(1000, 900), { window: 500, maxDeletes: 20 })).toEqual({
      start: 900,
      end: 900,
    });
  });

  test("clamps a malformed delete floor to the live floor", () => {
    expect(computeRetirableRange(cur(10, 900), { window: 0, maxDeletes: 20 })).toEqual({
      start: 10,
      end: 10,
    });
  });

  test("treats an absent delete floor as zero", () => {
    expect(computeRetirableRange(cur(1000), { window: 500, maxDeletes: 20 })).toEqual({
      start: 0,
      end: 20,
    });
  });

  test("never returns an end above log_seq_start", () => {
    const range = computeRetirableRange(cur(10), { window: 0, maxDeletes: 1000 });
    expect(range.end).toBeLessThanOrEqual(10);
  });

  test("uses the default window before the retention boundary", () => {
    expect(computeRetirableRange(cur(LOG_RETENTION_SEQ_WINDOW - 1))).toEqual({
      start: 0,
      end: 0,
    });
  });

  test("uses the default delete budget after the retention boundary", () => {
    expect(computeRetirableRange(cur(LOG_RETENTION_SEQ_WINDOW + 100))).toEqual({
      start: 0,
      end: 20,
    });
  });
});
