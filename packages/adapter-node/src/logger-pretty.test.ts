import { reset } from "@logtape/logtape";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATEGORY, configureObservability, getLogger } from "@baerly/server/observability";
import { prettyConsoleSink } from "./logger-pretty.ts";

describe("prettyConsoleSink", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
    // The kernel only accepts `"console-json"` or a `Sink` function;
    // pretty rendering is constructed locally and passed through as
    // a function.
    await configureObservability({ sink: prettyConsoleSink(), level: "info", sampleRate: 1 });
  });

  afterEach(async () => {
    spy.mockRestore();
    await reset();
  });

  it("renders an HTTP canonical line with method, path, status, duration, class_a/b", () => {
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

  it("renders wamp on a write when the prop is present", () => {
    getLogger(CATEGORY.http).info("canonical", {
      request_id: "ab12cd34-ef56-7890-abcd-ef1234567890",
      duration_ms: 20,
      status: 201,
      outcome: "committed",
      method: "POST",
      path: "/v1/t/tickets",
      "db.storage.class_a_ops_total": 3,
      "db.storage.class_b_ops_total": 0,
      "db.write.class_a_ops_per_logical_write_p99": 7,
    });
    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain("wamp=7");
  });

  it("renders outcome on >= 400 and 412 counter when > 0", () => {
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

  it("renders a maintenance line with ⚙ prefix and duration", () => {
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

  it("cache_status: 'hit' → cache=hit in tail", () => {
    getLogger(CATEGORY.http).info("canonical", {
      request_id: "ab12cd34-ef56-7890-abcd-ef1234567890",
      duration_ms: 5,
      status: 200,
      outcome: "read",
      method: "GET",
      path: "/v1/t/tickets",
      "db.storage.class_a_ops_total": 1,
      "db.storage.class_b_ops_total": 0,
      cache_status: "hit",
    });
    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain("cache=hit");
  });

  it("cache_status: 'miss' → cache=miss in tail", () => {
    getLogger(CATEGORY.http).info("canonical", {
      request_id: "ab12cd34-ef56-7890-abcd-ef1234567890",
      duration_ms: 12,
      status: 200,
      outcome: "read",
      method: "GET",
      path: "/v1/t/tickets",
      "db.storage.class_a_ops_total": 2,
      "db.storage.class_b_ops_total": 0,
      cache_status: "miss",
    });
    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain("cache=miss");
  });

  it("absent cache_status → no cache= in tail", () => {
    getLogger(CATEGORY.http).info("canonical", {
      request_id: "ab12cd34-ef56-7890-abcd-ef1234567890",
      duration_ms: 5,
      status: 200,
      outcome: "read",
      method: "GET",
      path: "/v1/t/tickets",
      "db.storage.class_a_ops_total": 1,
      "db.storage.class_b_ops_total": 0,
    });
    const line = spy.mock.calls[0]![0] as string;
    expect(line).not.toContain("cache=");
  });

  it("falls back to JSON-style for non-canonical records", () => {
    getLogger(CATEGORY.http).warn("verifier_rejected", { reason: "null" });
    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain("WARN");
    expect(line).toContain("verifier_rejected");
    expect(line).toContain('"reason":"null"');
  });
});
