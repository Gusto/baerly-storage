import { BaerlyError } from "@baerly/protocol";
import { reset, type LogRecord, type Sink } from "@logtape/logtape";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushCanonicalLine, withObservability } from "./canonical.ts";
import { createObservabilityContext, type ObservabilityContext } from "./context.ts";
import { configureObservability } from "./logger.ts";
import { RequestScopedMetricsRecorder } from "./recorder.ts";

const collectingSink = (): { records: LogRecord[]; sink: Sink } => {
  const records: LogRecord[] = [];
  const sink: Sink = (record) => records.push(record);
  return { records, sink };
};

const sampledCtx = (): ObservabilityContext => {
  const ctx = createObservabilityContext();
  ctx.sampled_by_head = true;
  return ctx;
};

describe("flushCanonicalLine", () => {
  let records: LogRecord[];
  let sink: Sink;

  beforeEach(async () => {
    ({ records, sink } = collectingSink());
    await configureObservability({ level: "debug", sink, sampleRate: 1 });
  });

  afterEach(async () => {
    await reset();
  });

  it("emits exactly one canonical line per unit-of-work", () => {
    flushCanonicalLine(sampledCtx(), new RequestScopedMetricsRecorder(), {
      unit: "http",
      outcome: "ok",
      status: 200,
    });
    expect(records).toHaveLength(1);
    expect(records[0]!.message.join("")).toBe("canonical");
  });

  it("spreads recorder.summarize() onto properties", () => {
    const r = new RequestScopedMetricsRecorder();
    r.counter("db.r2.put.412_total", 2);
    r.histogram("db.write.class_a_ops_per_logical_write", 3);
    flushCanonicalLine(sampledCtx(), r, { unit: "http", outcome: "ok", status: 200 });
    expect(records).toHaveLength(1);
    expect(records[0]!.properties["db.r2.put.412_total_total"]).toBe(2);
    expect(records[0]!.properties["db.write.class_a_ops_per_logical_write_count"]).toBe(1);
  });

  it("attaches request_id, duration_ms, status, and outcome", () => {
    const ctx = sampledCtx();
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

  it("spreads ctx.fields and opts.extra (extra overrides)", () => {
    const ctx = sampledCtx();
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
    it("status>=500 → error level", () => {
      flushCanonicalLine(sampledCtx(), new RequestScopedMetricsRecorder(), {
        unit: "http",
        outcome: "internal_error",
        status: 500,
      });
      expect(records[0]!.level).toBe("error");
    });

    it("status>=400 → warning level", () => {
      flushCanonicalLine(sampledCtx(), new RequestScopedMetricsRecorder(), {
        unit: "http",
        outcome: "client_error",
        status: 404,
      });
      expect(records[0]!.level).toBe("warning");
    });

    it("otherwise → info level", () => {
      flushCanonicalLine(sampledCtx(), new RequestScopedMetricsRecorder(), {
        unit: "http",
        outcome: "ok",
        status: 200,
      });
      expect(records[0]!.level).toBe("info");
    });

    it("error present → error level (overrides status)", () => {
      flushCanonicalLine(sampledCtx(), new RequestScopedMetricsRecorder(), {
        unit: "http",
        outcome: "internal_error",
        status: 200,
        error: new BaerlyError("Internal", "boom"),
      });
      expect(records[0]!.level).toBe("error");
    });
  });

  describe("sampling", () => {
    it("suppresses when neither sampled_by_head nor force_kept_by_error", () => {
      const ctx = createObservabilityContext(); // sampled_by_head=false
      flushCanonicalLine(ctx, new RequestScopedMetricsRecorder(), {
        unit: "http",
        outcome: "ok",
        status: 200,
      });
      expect(records).toHaveLength(0);
    });

    it("emits when sampled_by_head=true", () => {
      flushCanonicalLine(sampledCtx(), new RequestScopedMetricsRecorder(), {
        unit: "http",
        outcome: "ok",
        status: 200,
      });
      expect(records).toHaveLength(1);
    });

    it("error force-keep overrides head rejection AND flips ctx.force_kept_by_error", () => {
      const ctx = createObservabilityContext();
      flushCanonicalLine(ctx, new RequestScopedMetricsRecorder(), {
        unit: "http",
        outcome: "internal_error",
        status: 500,
        error: new Error("boom"),
      });
      expect(records).toHaveLength(1);
      expect(ctx.force_kept_by_error).toBe(true);
    });
  });

  it("error path produces a serializeError'd `error` property", () => {
    flushCanonicalLine(sampledCtx(), new RequestScopedMetricsRecorder(), {
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

  it("routes to the right category per unit", () => {
    flushCanonicalLine(sampledCtx(), new RequestScopedMetricsRecorder(), {
      unit: "maintenance",
      outcome: "ok",
    });
    flushCanonicalLine(sampledCtx(), new RequestScopedMetricsRecorder(), {
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
    await configureObservability({ level: "debug", sink, sampleRate: 1 });
  });

  afterEach(async () => {
    await reset();
  });

  it("flushes one canonical line on success and returns the body's value", async () => {
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

  it("flushes one canonical line on error and re-throws", async () => {
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

  it("propagates the observability context to the body", async () => {
    await withObservability("gc", async (ctx) => {
      expect(typeof ctx.request_id).toBe("string");
      expect(ctx.request_id.length).toBeGreaterThan(0);
    });
  });

  it("the body's recorder is the same instance attached to ctx.recorder", async () => {
    await withObservability("maintenance", async (ctx, rec) => {
      expect(rec).toBe(ctx.recorder);
      rec.counter("via_body", 1);
      // The same recorder is reachable from inside the body without
      // closure capture (this is what adapters in Dispatch 4 rely on).
      expect(ctx.recorder.snapshot().counters).toHaveLength(1);
    });
  });

  it("sample-rate=0 still emits on error path", async () => {
    await reset();
    await configureObservability({ level: "debug", sink, sampleRate: 0 });
    await expect(
      withObservability("rebuild", async () => {
        throw new Error("x");
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(records).toHaveLength(1);
    expect(records[0]!.level).toBe("error");
  });

  it("sample-rate=0 suppresses the success-path canonical line", async () => {
    await reset();
    await configureObservability({ level: "debug", sink, sampleRate: 0 });
    await withObservability("maintenance", async () => "ok");
    expect(records).toHaveLength(0);
  });
});
