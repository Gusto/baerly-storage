import { BaerlyError } from "@baerly/protocol";
import { reset, type LogRecord, type Sink } from "@logtape/logtape";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { flushCanonicalLine, serializeError, withObservability } from "./canonical.ts";
import { createObservabilityContext } from "./context.ts";
import { configureObservability } from "./logger.ts";
import { RequestScopedMetricsRecorder } from "./recorder.ts";

const collectingSink = (): { records: LogRecord[]; sink: Sink } => {
  const records: LogRecord[] = [];
  const sink: Sink = (record) => records.push(record);
  return { records, sink };
};

describe("flushCanonicalLine", () => {
  let records: LogRecord[];
  let sink: Sink;

  beforeEach(async () => {
    ({ records, sink } = collectingSink());
    await configureObservability({ level: "debug", sink });
  });

  afterEach(async () => {
    await reset();
  });

  test("emits exactly one canonical line per unit-of-work", () => {
    flushCanonicalLine(createObservabilityContext(), new RequestScopedMetricsRecorder(), {
      unit: "http",
      outcome: "ok",
      status: 200,
    });
    expect(records).toHaveLength(1);
    expect(records[0]!.message.join("")).toBe("canonical");
  });

  test("spreads recorder.summarize() onto properties", () => {
    const r = new RequestScopedMetricsRecorder();
    r.counter("db.r2.put.412_total", 2);
    r.histogram("db.write.class_a_ops_per_logical_write", 3);
    flushCanonicalLine(createObservabilityContext(), r, {
      unit: "http",
      outcome: "ok",
      status: 200,
    });
    expect(records).toHaveLength(1);
    expect(records[0]!.properties["db.r2.put.412_total"]).toBe(2);
    expect(records[0]!.properties["db.write.class_a_ops_per_logical_write_count"]).toBe(1);
  });

  test("attaches request_id, duration_ms, status, and outcome", () => {
    const ctx = createObservabilityContext();
    flushCanonicalLine(ctx, new RequestScopedMetricsRecorder(), {
      unit: "http",
      outcome: "ok",
      status: 200,
    });
    const p = records[0]!.properties;
    expect(p["request_id"]).toBe(ctx.request_id);
    expect(p["status"]).toBe(200);
    expect(p["outcome"]).toBe("ok");
    expect(typeof p["duration_ms"]).toBe("number");
    expect((p["duration_ms"] as number) >= 0).toBe(true);
  });

  test("spreads ctx.fields and opts.extra (extra overrides)", () => {
    const ctx = createObservabilityContext();
    ctx.fields.set("collection", "tickets");
    ctx.fields.set("verb", "POST");
    flushCanonicalLine(ctx, new RequestScopedMetricsRecorder(), {
      unit: "http",
      outcome: "ok",
      status: 200,
      extra: { verb: "PUT", route: "/v1/x" },
    });
    const p = records[0]!.properties;
    expect(p["collection"]).toBe("tickets");
    expect(p["verb"]).toBe("PUT"); // extra wins
    expect(p["route"]).toBe("/v1/x");
  });

  describe("level picking", () => {
    test("status>=500 → error level", () => {
      flushCanonicalLine(createObservabilityContext(), new RequestScopedMetricsRecorder(), {
        unit: "http",
        outcome: "internal_error",
        status: 500,
      });
      expect(records[0]!.level).toBe("error");
    });

    test("status>=400 → warning level", () => {
      flushCanonicalLine(createObservabilityContext(), new RequestScopedMetricsRecorder(), {
        unit: "http",
        outcome: "client_error",
        status: 404,
      });
      expect(records[0]!.level).toBe("warning");
    });

    test("otherwise → info level", () => {
      flushCanonicalLine(createObservabilityContext(), new RequestScopedMetricsRecorder(), {
        unit: "http",
        outcome: "ok",
        status: 200,
      });
      expect(records[0]!.level).toBe("info");
    });

    test("error present → error level (overrides status)", () => {
      flushCanonicalLine(createObservabilityContext(), new RequestScopedMetricsRecorder(), {
        unit: "http",
        outcome: "internal_error",
        status: 200,
        error: new BaerlyError("Internal", "boom"),
      });
      expect(records[0]!.level).toBe("error");
    });
  });

  test("every canonical line emits — no sampling gate", () => {
    flushCanonicalLine(createObservabilityContext(), new RequestScopedMetricsRecorder(), {
      unit: "http",
      outcome: "ok",
      status: 200,
    });
    expect(records).toHaveLength(1);
  });

  test("error path produces a serializeError'd `error` property", () => {
    flushCanonicalLine(createObservabilityContext(), new RequestScopedMetricsRecorder(), {
      unit: "http",
      outcome: "conflict",
      status: 409,
      error: new BaerlyError("Conflict", "CAS lost"),
    });
    expect(records).toHaveLength(1);
    const err = records[0]!.properties["error"] as { code: string; message: string };
    expect(err.code).toBe("Conflict");
    expect(err.message).toBe("CAS lost");
  });

  test("routes to the right category per unit", () => {
    flushCanonicalLine(createObservabilityContext(), new RequestScopedMetricsRecorder(), {
      unit: "maintenance",
      outcome: "ok",
    });
    flushCanonicalLine(createObservabilityContext(), new RequestScopedMetricsRecorder(), {
      unit: "compactor",
      outcome: "ok",
    });
    expect(records.map((r) => r.category)).toEqual([
      ["baerly", "maintenance"],
      ["baerly", "compactor"],
    ]);
  });
});

describe("withObservability", () => {
  let records: LogRecord[];
  let sink: Sink;

  beforeEach(async () => {
    ({ records, sink } = collectingSink());
    await configureObservability({ level: "debug", sink });
  });

  afterEach(async () => {
    await reset();
  });

  test("flushes one canonical line on success and returns the body's value", async () => {
    const result = await withObservability("maintenance", async (ctx, rec) => {
      rec.counter("did_work", 1);
      ctx.fields.set("phase", "compactor");
      return 42;
    });
    expect(result).toBe(42);
    expect(records).toHaveLength(1);
    const p = records[0]!.properties;
    expect(p["outcome"]).toBe("ok");
    expect(p["phase"]).toBe("compactor");
    expect(p["did_work_total"]).toBe(1);
  });

  test("flushes one canonical line on error and re-throws", async () => {
    const boom = new BaerlyError("Internal", "kaboom");
    await expect(
      withObservability("compactor", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(records).toHaveLength(1);
    expect(records[0]!.level).toBe("error");
    expect(records[0]!.properties["outcome"]).toBe("error");
    const err = records[0]!.properties["error"] as { code: string; message: string };
    expect(err.code).toBe("Internal");
    expect(err.message).toBe("kaboom");
  });

  test("propagates the observability context to the body", async () => {
    await withObservability("gc", async (ctx) => {
      expect(typeof ctx.request_id).toBe("string");
      expect(ctx.request_id.length).toBeGreaterThan(0);
    });
  });

  test("the body's recorder is the same instance attached to ctx.recorder", async () => {
    await withObservability("maintenance", async (ctx, rec) => {
      expect(rec).toBe(ctx.recorder);
      rec.counter("via_body", 1);
      // The same recorder is reachable from inside the body without
      // closure capture (this is what adapters in Dispatch 4 rely on).
      expect(ctx.recorder.snapshot().counters).toHaveLength(1);
    });
  });
});

describe("serializeError", () => {
  describe("BaerlyError", () => {
    test("preserves the code discriminant", () => {
      const err = new BaerlyError("Conflict", "CAS lost");
      expect(serializeError(err)).toEqual({ code: "Conflict", message: "CAS lost" });
    });

    test("does not include the stack by default", () => {
      const err = new BaerlyError("InvalidConfig", "bad bucket");
      expect(serializeError(err).stack).toBeUndefined();
    });
  });

  describe("plain Error", () => {
    test("collapses code to 'Internal' and keeps the message", () => {
      const err = new Error("boom");
      expect(serializeError(err)).toEqual({ code: "Internal", message: "boom" });
    });
  });

  describe("non-Error values", () => {
    test("stringifies strings via String()", () => {
      expect(serializeError("oops")).toEqual({ code: "Internal", message: "oops" });
    });

    test("stringifies numbers via String()", () => {
      expect(serializeError(42)).toEqual({ code: "Internal", message: "42" });
    });

    test("stringifies undefined and null", () => {
      expect(serializeError(undefined)).toEqual({ code: "Internal", message: "undefined" });
      expect(serializeError(null)).toEqual({ code: "Internal", message: "null" });
    });

    test("JSON-stringifies plain objects", () => {
      expect(serializeError({ a: 1, b: "x" })).toEqual({
        code: "Internal",
        message: JSON.stringify({ a: 1, b: "x" }),
      });
    });

    test("falls back to [unserializable object] on JSON-stringify failure", () => {
      const circular: Record<string, unknown> = {};
      circular["self"] = circular;
      expect(serializeError(circular)).toEqual({
        code: "Internal",
        message: "[unserializable object]",
      });
    });
  });

  describe("stack inclusion", () => {
    test("omits stack when includeStack=false", () => {
      const err = new BaerlyError("Internal", "x");
      expect(serializeError(err, false).stack).toBeUndefined();
    });

    test("includes stack when includeStack=true (BaerlyError)", () => {
      const err = new BaerlyError("Internal", "stack-marker-message");
      const out = serializeError(err, true);
      expect(typeof out.stack).toBe("string");
      expect(out.stack).toContain("stack-marker-message");
    });

    test("includes stack when includeStack=true (plain Error)", () => {
      const err = new Error("boom");
      const out = serializeError(err, true);
      expect(typeof out.stack).toBe("string");
    });
  });
});

describe("flushCanonicalLine stack inclusion at error level", () => {
  let records: LogRecord[];
  let sink: Sink;

  beforeEach(async () => {
    ({ records, sink } = collectingSink());
    await configureObservability({ level: "debug", sink });
  });

  afterEach(async () => {
    await reset();
  });

  test("includes stack at error level", () => {
    flushCanonicalLine(createObservabilityContext(), new RequestScopedMetricsRecorder(), {
      unit: "http",
      outcome: "internal_error",
      status: 500,
      error: new BaerlyError("Internal", "stack-marker-message"),
    });
    const err = records[0]!.properties["error"] as { stack?: string };
    expect(typeof err.stack).toBe("string");
    expect(err.stack).toContain("stack-marker-message");
  });

  test("omits stack at info level (success path, no error envelope)", () => {
    flushCanonicalLine(createObservabilityContext(), new RequestScopedMetricsRecorder(), {
      unit: "http",
      outcome: "ok",
      status: 200,
    });
    expect(records[0]!.properties["error"]).toBeUndefined();
  });
});
