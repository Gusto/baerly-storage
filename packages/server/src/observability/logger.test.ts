import { reset, type LogRecord, type Sink } from "@logtape/logtape";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATEGORY, configureObservability, getEffectiveSampleRate, getLogger } from "./logger.ts";

/**
 * In-memory sink for tests. LogTape doesn't ship a built-in
 * `getMemorySink`; building one on top of the `Sink` type
 * (`(record) => void`) is the recommended pattern in the docs.
 */
const collectingSink = (): { records: LogRecord[]; sink: Sink } => {
  const records: LogRecord[] = [];
  const sink: Sink = (record) => records.push(record);
  return { records, sink };
};

describe("configureObservability + getLogger", () => {
  let prevLogLevel: string | undefined;
  let prevLogSample: string | undefined;

  beforeEach(() => {
    prevLogLevel = process.env["LOG_LEVEL"];
    prevLogSample = process.env["LOG_SAMPLE"];
  });

  afterEach(async () => {
    if (prevLogLevel === undefined) delete process.env["LOG_LEVEL"];
    else process.env["LOG_LEVEL"] = prevLogLevel;
    if (prevLogSample === undefined) delete process.env["LOG_SAMPLE"];
    else process.env["LOG_SAMPLE"] = prevLogSample;
    await reset();
  });

  it("level=info filters debug out and allows info/warn/error", async () => {
    const { records, sink } = collectingSink();
    await configureObservability({ level: "info", sink });

    getLogger(CATEGORY.http).debug("ignored");
    getLogger(CATEGORY.http).info("kept", { x: 1 });
    getLogger(CATEGORY.http).warn("kept-warn");
    getLogger(CATEGORY.http).error("kept-err");

    expect(records.map((r) => r.level)).toEqual(["info", "warning", "error"]);
  });

  it("level=debug allows everything", async () => {
    const { records, sink } = collectingSink();
    await configureObservability({ level: "debug", sink });
    getLogger(CATEGORY.http).debug("d");
    getLogger(CATEGORY.http).info("i");
    expect(records.map((r) => r.level)).toEqual(["debug", "info"]);
  });

  it("LOG_LEVEL env override is honoured when no typed option supplied", async () => {
    const { records, sink } = collectingSink();
    process.env["LOG_LEVEL"] = "debug";
    await configureObservability({ sink });
    getLogger(CATEGORY.http).debug("kept");
    getLogger(CATEGORY.http).info("kept");
    expect(records.map((r) => r.level)).toEqual(["debug", "info"]);
  });

  it("LOG_LEVEL=warn maps to LogTape 'warning' and filters info out", async () => {
    const { records, sink } = collectingSink();
    process.env["LOG_LEVEL"] = "warn";
    await configureObservability({ sink });
    getLogger(CATEGORY.http).info("dropped");
    getLogger(CATEGORY.http).warn("kept");
    expect(records.map((r) => r.level)).toEqual(["warning"]);
  });

  it("round-trips properties through the memory sink", async () => {
    const { records, sink } = collectingSink();
    await configureObservability({ level: "info", sink });
    getLogger(CATEGORY.http).info("event", { foo: 1, bar: "x" });
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.category).toEqual(["baerly", "http"]);
    expect(rec.level).toBe("info");
    expect(rec.properties).toEqual({ foo: 1, bar: "x" });
  });

  it("is idempotent — calling twice doesn't double-emit", async () => {
    const { records: r1, sink: s1 } = collectingSink();
    await configureObservability({ level: "info", sink: s1 });
    const { records: r2, sink: s2 } = collectingSink();
    await configureObservability({ level: "info", sink: s2 });

    getLogger(CATEGORY.http).info("event");
    expect(r1).toHaveLength(0);
    expect(r2).toHaveLength(1);
  });
});

describe("getEffectiveSampleRate", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env["LOG_SAMPLE"];
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env["LOG_SAMPLE"];
    else process.env["LOG_SAMPLE"] = prev;
    await reset();
  });

  it("returns the configured rate after configureObservability", async () => {
    await configureObservability({ sampleRate: 0.25 });
    expect(getEffectiveSampleRate()).toBe(0.25);
  });

  it("falls back to LOG_SAMPLE env when no typed option supplied", async () => {
    process.env["LOG_SAMPLE"] = "0.1";
    await configureObservability({});
    expect(getEffectiveSampleRate()).toBeCloseTo(0.1, 5);
  });

  it("clamps out-of-range rates into [0, 1]", async () => {
    await configureObservability({ sampleRate: 5 });
    expect(getEffectiveSampleRate()).toBe(1);
    await configureObservability({ sampleRate: -1 });
    expect(getEffectiveSampleRate()).toBe(0);
  });
});

describe("prettyConsoleSink", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    spy.mockRestore();
    await reset();
  });

  it("renders an HTTP canonical line with method, path, status, duration, class_a/b", async () => {
    await configureObservability({ sink: "console-pretty", level: "info", sampleRate: 1 });

    getLogger(CATEGORY.http).info("canonical", {
      request_id: "ab12cd34-ef56-7890-abcd-ef1234567890",
      duration_ms: 1.2,
      status: 200,
      outcome: "read",
      method: "GET",
      path: "/v1/t/tickets",
      "db.storage.class_a_ops_total": 0,
      "db.storage.class_b_ops_total": 1,
    });

    expect(spy).toHaveBeenCalledOnce();
    const line = spy.mock.calls[0]![0] as string;
    expect(line).toMatch(/GET\s+\/v1\/t\/tickets/);
    expect(line).toMatch(/200\s+1ms/);
    expect(line).toContain("req=ab12cd34");
    expect(line).toContain("class_a=0");
    expect(line).toContain("class_b=1");
    expect(line).not.toContain("outcome=read"); // suppressed on 2xx
  });

  it("renders wamp on a write when the prop is present", async () => {
    await configureObservability({ sink: "console-pretty", level: "info", sampleRate: 1 });

    getLogger(CATEGORY.http).info("canonical", {
      request_id: "ab12cd34-ef56-7890-abcd-ef1234567890",
      duration_ms: 20,
      status: 201,
      outcome: "committed",
      method: "POST",
      path: "/v1/t/tickets",
      "db.storage.class_a_ops_total": 3,
      "db.storage.class_b_ops_total": 0,
      "db.write.class_a_ops_per_logical_write_p99": 3,
    });
    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain("wamp=3");
  });

  it("renders outcome on >= 400 and 412 counter when > 0", async () => {
    await configureObservability({ sink: "console-pretty", level: "info", sampleRate: 1 });

    getLogger(CATEGORY.http).warn("canonical", {
      request_id: "ab12cd34-ef56-7890-abcd-ef1234567890",
      duration_ms: 8,
      status: 409,
      outcome: "conflict",
      method: "POST",
      path: "/v1/t/tickets",
      "db.storage.class_a_ops_total": 1,
      "db.storage.class_b_ops_total": 0,
      "db.r2.put.412_total": 1,
    });
    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain("409");
    expect(line).toContain("outcome=conflict");
    expect(line).toContain("412=1");
  });

  it("renders a maintenance line with ⚙ prefix and duration", async () => {
    await configureObservability({ sink: "console-pretty", level: "info", sampleRate: 1 });

    getLogger(CATEGORY.maintenance).info("canonical", {
      request_id: "ef56gh78-aaaa-bbbb-cccc-dddddddddddd",
      duration_ms: 142,
      outcome: "ok",
      "db.storage.class_a_ops_total": 4,
    });
    const line = spy.mock.calls[0]![0] as string;
    expect(line).toMatch(/maintenance/);
    expect(line).toContain("142ms");
    expect(line).toContain("class_a=4");
  });

  it("falls back to JSON-style for non-canonical records", async () => {
    await configureObservability({ sink: "console-pretty", level: "info", sampleRate: 1 });

    getLogger(CATEGORY.http).warn("verifier_rejected", { reason: "null" });
    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain("WARN");
    expect(line).toContain("verifier_rejected");
    expect(line).toContain('"reason":"null"');
  });
});

describe("CATEGORY", () => {
  it('includes every documented category as a ["baerly", <unit>] tuple', () => {
    expect(CATEGORY).toEqual({
      http: ["baerly", "http"],
      writer: ["baerly", "writer"],
      maintenance: ["baerly", "maintenance"],
      compactor: ["baerly", "compactor"],
      gc: ["baerly", "gc"],
      rebuild: ["baerly", "rebuild"],
      storage: ["baerly", "storage"],
      auth: ["baerly", "auth"],
    });
  });
});
