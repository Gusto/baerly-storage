import { describe, expect, test } from "vitest";
import { createObservabilityContext, getCurrentContext, runWithContext } from "./context.ts";
import { RequestScopedMetricsRecorder } from "./recorder.ts";

describe("createObservabilityContext", () => {
  test("assigns a fresh request_id when none is supplied", () => {
    const a = createObservabilityContext();
    const b = createObservabilityContext();
    expect(a.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.request_id).not.toBe(b.request_id);
  });

  test("honours an externally-supplied request_id", () => {
    const ctx = createObservabilityContext({ request_id: "ext-123" });
    expect(ctx.request_id).toBe("ext-123");
  });

  test("captures started_at as a finite, non-negative number", () => {
    const ctx = createObservabilityContext();
    expect(Number.isFinite(ctx.started_at)).toBe(true);
    expect(ctx.started_at).toBeGreaterThanOrEqual(0);
  });

  test("starts with an empty fields map", () => {
    const ctx = createObservabilityContext();
    expect(ctx.fields.size).toBe(0);
  });

  test("constructs a fresh RequestScopedMetricsRecorder by default", () => {
    const a = createObservabilityContext();
    const b = createObservabilityContext();
    expect(a.recorder).toBeInstanceOf(RequestScopedMetricsRecorder);
    expect(b.recorder).toBeInstanceOf(RequestScopedMetricsRecorder);
    // Two distinct contexts get two distinct recorders.
    expect(a.recorder).not.toBe(b.recorder);
    // The default recorder starts empty.
    const snap = a.recorder.snapshot();
    expect(snap.counters).toEqual([]);
    expect(snap.gauges).toEqual([]);
    expect(snap.histograms).toEqual([]);
  });

  test("honours an externally-supplied recorder", () => {
    const r = new RequestScopedMetricsRecorder();
    r.counter("seeded", 1);
    const ctx = createObservabilityContext({ recorder: r });
    expect(ctx.recorder).toBe(r);
    expect(ctx.recorder.snapshot().counters).toHaveLength(1);
  });
});

describe("runWithContext + getCurrentContext", () => {
  test("returns undefined outside any runWithContext call", () => {
    expect(getCurrentContext()).toBeUndefined();
  });

  test("propagates through synchronous code", () => {
    const ctx = createObservabilityContext({ request_id: "sync" });
    runWithContext(ctx, () => {
      expect(getCurrentContext()?.request_id).toBe("sync");
    });
    expect(getCurrentContext()).toBeUndefined();
  });

  test("propagates through awaits", async () => {
    const ctx = createObservabilityContext({ request_id: "await" });
    await runWithContext(ctx, async () => {
      expect(getCurrentContext()?.request_id).toBe("await");
      await Promise.resolve();
      expect(getCurrentContext()?.request_id).toBe("await");
    });
    expect(getCurrentContext()).toBeUndefined();
  });

  test("propagates through Promise.all", async () => {
    const ctx = createObservabilityContext({ request_id: "all" });
    await runWithContext(ctx, async () => {
      const ids = await Promise.all([
        Promise.resolve().then(() => getCurrentContext()?.request_id),
        Promise.resolve().then(() => getCurrentContext()?.request_id),
      ]);
      expect(ids).toEqual(["all", "all"]);
    });
  });

  test("propagates through setTimeout", async () => {
    const ctx = createObservabilityContext({ request_id: "timer" });
    const id = await runWithContext(
      ctx,
      async () =>
        new Promise<string | undefined>((resolve) => {
          setTimeout(() => resolve(getCurrentContext()?.request_id), 1);
        }),
    );
    expect(id).toBe("timer");
  });

  test("stacks nested runWithContext calls — inner wins, outer restores on exit", () => {
    const outer = createObservabilityContext({ request_id: "outer" });
    const inner = createObservabilityContext({ request_id: "inner" });
    runWithContext(outer, () => {
      expect(getCurrentContext()?.request_id).toBe("outer");
      runWithContext(inner, () => {
        expect(getCurrentContext()?.request_id).toBe("inner");
      });
      expect(getCurrentContext()?.request_id).toBe("outer");
    });
    expect(getCurrentContext()).toBeUndefined();
  });

  test("fields map is mutable through getCurrentContext", () => {
    const ctx = createObservabilityContext();
    runWithContext(ctx, () => {
      getCurrentContext()?.fields.set("collection", "tickets");
      getCurrentContext()?.fields.set("op_count", 3);
    });
    expect(ctx.fields.get("collection")).toBe("tickets");
    expect(ctx.fields.get("op_count")).toBe(3);
  });

  test("preserves fn's return value as-is", async () => {
    const ctx = createObservabilityContext();
    const sync = runWithContext(ctx, () => 42);
    expect(sync).toBe(42);
    const asyncResult = await runWithContext(ctx, async () => "hi");
    expect(asyncResult).toBe("hi");
  });
});
