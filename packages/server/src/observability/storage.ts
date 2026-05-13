/**
 * `Storage` decorator that emits per-op observability:
 *
 * - One histogram observation per call: `db.storage.<op>.duration_ms`.
 * - One counter increment per call: `db.storage.<op>.calls_total`.
 * - One counter increment per class A / class B classification:
 *   `db.storage.class_a_ops_total` / `db.storage.class_b_ops_total`.
 *   We follow S3 pricing: PUT / DELETE / LIST count as class A;
 *   GET counts as class B. (S3 charges Class A for PUT/POST/COPY/
 *   LIST and Class B for GET/HEAD; DELETE is free under S3 but
 *   we still count it as class A internally because it triggers
 *   write-side traffic in the kernel's accounting.)
 * - On error: counter increment `db.storage.<op>.errors_total` and
 *   re-throw the original value verbatim.
 *
 * Read paths are NOT decorated by default; consumers pass a
 * recorder when they want observation. The default no-op recorder
 * still works — every emission is a single function call.
 *
 * The decorator preserves the `Storage` contract exactly: same
 * input types, same output types, same `null`-on-not-found
 * convention, same `AsyncIterable` for `list`.
 *
 * The debug-level per-call log line is gated on
 * `getLogger(CATEGORY.storage).isEnabledFor("debug")` so we don't
 * pay the formatting cost in production where the level is
 * `info` or higher. (LogTape provides `isEnabledFor` since 2.0.0.)
 */

import type {
  MetricsRecorder,
  Storage,
  StorageGetOptions,
  StorageGetResult,
  StorageListEntry,
  StoragePutOptions,
  StoragePutResult,
} from "@baerly/protocol";
import { CATEGORY, getLogger } from "./logger.ts";

type Op = "get" | "put" | "delete" | "list";

const CLASS_A_OPS: ReadonlySet<Op> = new Set<Op>(["put", "delete", "list"]);

/**
 * Wrap `inner` with metric emission. The returned object is itself
 * a `Storage` impl and passes the `Storage` conformance suite
 * (round-trip semantics, ETag preservation, `list` ordering — none
 * of which the decorator touches).
 */
export const observableStorage = (inner: Storage, recorder: MetricsRecorder): Storage => {
  const logger = getLogger(CATEGORY.storage);
  const debug = (
    op: Op,
    key: string,
    durationMs: number,
    outcome: string,
    bytes?: number,
  ): void => {
    if (!logger.isEnabledFor("debug")) return;
    const props: Record<string, unknown> = { op, key, duration_ms: durationMs, outcome };
    if (bytes !== undefined) props["bytes"] = bytes;
    logger.debug("storage", props);
  };

  const recordCall = (op: Op): void => {
    recorder.counter(`db.storage.${op}.calls_total`, 1);
    recorder.counter(
      CLASS_A_OPS.has(op) ? "db.storage.class_a_ops_total" : "db.storage.class_b_ops_total",
      1,
    );
  };

  const recordError = (op: Op): void => {
    recorder.counter(`db.storage.${op}.errors_total`, 1);
  };

  const recordDuration = (op: Op, durationMs: number): void => {
    recorder.histogram(`db.storage.${op}.duration_ms`, durationMs);
  };

  return {
    async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
      const op: Op = "get";
      recordCall(op);
      const start = performance.now();
      try {
        const result = await inner.get(key, opts);
        const dt = performance.now() - start;
        recordDuration(op, dt);
        debug(op, key, dt, result === null ? "miss" : "hit", result?.body.byteLength);
        return result;
      } catch (err) {
        const dt = performance.now() - start;
        recordDuration(op, dt);
        recordError(op);
        debug(op, key, dt, "error");
        throw err;
      }
    },

    async put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> {
      const op: Op = "put";
      recordCall(op);
      const start = performance.now();
      try {
        const result = await inner.put(key, body, opts);
        const dt = performance.now() - start;
        recordDuration(op, dt);
        debug(op, key, dt, "ok", body.byteLength);
        return result;
      } catch (err) {
        const dt = performance.now() - start;
        recordDuration(op, dt);
        recordError(op);
        debug(op, key, dt, "error", body.byteLength);
        throw err;
      }
    },

    async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
      const op: Op = "delete";
      recordCall(op);
      const start = performance.now();
      try {
        await inner.delete(key, opts);
        const dt = performance.now() - start;
        recordDuration(op, dt);
        debug(op, key, dt, "ok");
      } catch (err) {
        const dt = performance.now() - start;
        recordDuration(op, dt);
        recordError(op);
        debug(op, key, dt, "error");
        throw err;
      }
    },

    list(
      prefix: string,
      opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
    ): AsyncIterable<StorageListEntry> {
      const op: Op = "list";
      recordCall(op);
      const start = performance.now();
      const innerIter = inner.list(prefix, opts);
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for await (const entry of innerIter) yield entry;
            const dt = performance.now() - start;
            recordDuration(op, dt);
            debug(op, prefix, dt, "ok");
          } catch (err) {
            const dt = performance.now() - start;
            recordDuration(op, dt);
            recordError(op);
            debug(op, prefix, dt, "error");
            throw err;
          }
        },
      };
    },
  };
};
