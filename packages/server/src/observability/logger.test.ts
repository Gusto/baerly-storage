import { reset, type LogRecord, type Sink } from "@logtape/logtape";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CATEGORY, configureObservability, getEffectiveSampleRate, getLogger } from "./logger";

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
