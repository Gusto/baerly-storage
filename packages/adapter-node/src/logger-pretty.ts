/**
 * Pretty console sink for the `baerlyDev()` Vite-mount boot path.
 *
 * Lives in `@baerly/adapter-node` so the `@baerly/server` kernel
 * doesn't pull `picocolors` or the canonical-line column renderer
 * into its bundle. The kernel's `configureObservability` accepts any
 * `Sink` function directly; callers in TTY-friendly environments
 * (the Node adapter's `createApp` / `baerlyNode`) construct this sink
 * and pass it in.
 */

import { type LogRecord, type Sink } from "@logtape/logtape";
import { createColors } from "picocolors";

/**
 * Metric keys the pretty sink reads off the canonical-line record.
 * These names match `RequestScopedMetricsRecorder.summarize()` output
 * in `packages/server/src/observability/recorder.ts`. If the recorder
 * renames a key, update both sides here.
 */
const CANONICAL_KEYS = {
  classA: "db.storage.class_a_ops_total",
  classB: "db.storage.class_b_ops_total",
  wamp: "db.write.class_a_ops_per_logical_write_sum",
  put412: "db.r2.put.412_total",
  put429: "db.r2.put.429_total",
  cacheStatus: "cache_status",
} as const;

/**
 * Fixed-width column sizes for the pretty sink's HTTP line.
 * Local to the renderer — these are presentation defaults, not
 * protocol invariants, so they don't belong in `@baerly/protocol`.
 */
const METHOD_W = 6;
const PATH_W = 28;

const pickProp = (props: Record<string, unknown>, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(props, key) ? props[key] : undefined;

const numProp = (props: Record<string, unknown>, key: string): number | undefined => {
  const v = pickProp(props, key);
  return typeof v === "number" ? v : undefined;
};

type PicoColors = ReturnType<typeof createColors>;

// Color the status column by class: 5xx red, 4xx yellow, 3xx cyan,
// 2xx/unset dim. Extracted so the canonical-line renderer doesn't carry
// a 5-level nested ternary.
const colorStatus = (
  statusStr: string,
  status: number | undefined,
  plain: boolean,
  pc: PicoColors,
): string => {
  if (plain || status === undefined) {
    return statusStr;
  }
  if (status >= 500) {
    return pc.red(statusStr);
  }
  if (status >= 400) {
    return pc.yellow(statusStr);
  }
  if (status >= 300) {
    return pc.cyan(statusStr);
  }
  return pc.dim(statusStr);
};

const renderCanonical = (record: LogRecord, pc: PicoColors, plain: boolean): string => {
  const props = record.properties as Record<string, unknown>;
  const ts = new Date(record.timestamp).toISOString().slice(11, 19);
  const reqId = String(pickProp(props, "request_id") ?? "").slice(0, 8);
  const duration = numProp(props, "duration_ms") ?? 0;
  const durationStr = `${Math.round(duration)}ms`.padStart(5);

  const status = numProp(props, "status");
  const method =
    typeof pickProp(props, "method") === "string" ? String(pickProp(props, "method")) : "";
  const path = typeof pickProp(props, "path") === "string" ? String(pickProp(props, "path")) : "";

  const m = method.padEnd(METHOD_W);
  const p = path.length > PATH_W ? `${path.slice(0, PATH_W - 1)}…` : path.padEnd(PATH_W);
  const statusStr = status === undefined ? "   " : String(status);
  const coloredStatus = colorStatus(statusStr, status, plain, pc);
  const prefix = `${m}${p}  ${coloredStatus}  ${durationStr}`;

  const tail: string[] = [];
  if (reqId) {
    tail.push(`req=${reqId}`);
  }
  const classA = numProp(props, CANONICAL_KEYS.classA);
  const classB = numProp(props, CANONICAL_KEYS.classB);
  if (classA !== undefined) {
    tail.push(`class_a=${classA}`);
  }
  if (classB !== undefined) {
    tail.push(`class_b=${classB}`);
  }
  const wamp = numProp(props, CANONICAL_KEYS.wamp);
  if (wamp !== undefined) {
    tail.push(`wamp=${wamp}`);
  }
  const c412 = numProp(props, CANONICAL_KEYS.put412);
  if (c412 !== undefined && c412 > 0) {
    tail.push(`412=${c412}`);
  }
  const c429 = numProp(props, CANONICAL_KEYS.put429);
  if (c429 !== undefined && c429 > 0) {
    tail.push(`429=${c429}`);
  }
  const cacheStatus = pickProp(props, CANONICAL_KEYS.cacheStatus);
  if (typeof cacheStatus === "string") {
    tail.push(`cache=${cacheStatus}`);
  }
  if (status !== undefined && status >= 400) {
    const outcome = pickProp(props, "outcome");
    if (typeof outcome === "string") {
      tail.push(`outcome=${outcome}`);
    }
  }

  const tailStr = tail.length ? `  ${tail.join(" ")}` : "";
  const tsCol = plain ? `${ts} ` : `${pc.dim(ts)} `;
  return `${tsCol}${prefix}${tailStr}`;
};

const isCanonicalRecord = (record: LogRecord): boolean =>
  record.message.length === 1 && record.message[0] === "canonical";

const isPlainEnv = (): boolean => {
  const proc = (
    globalThis as {
      process?: {
        stdout?: { isTTY?: boolean };
        env?: Record<string, string | undefined>;
      };
    }
  ).process;
  return proc?.stdout?.isTTY !== true || proc?.env?.["CI"] !== undefined;
};

/**
 * Built-in pretty sink. Renders canonical-line records (the
 * single-emit/unit-of-work records produced by `flushCanonicalLine`
 * in `@baerly/server/observability`) in a column-aligned cost-aware
 * format intended for local dev; falls back to a generic
 * `<ts> <LEVEL> <category> <msg> <jsonProps>` layout for every
 * other record (warn-line `verifier_rejected`, debug storage
 * emits, etc.).
 *
 * Color is enabled when stderr is a TTY and `CI` is unset. Under
 * vitest, stderr is non-TTY so color is off — tests can assert
 * substring matches without stripping ANSI escapes.
 */
export const prettyConsoleSink = (): Sink => {
  const plain = isPlainEnv();
  const pc = createColors(!plain);
  return (record) => {
    if (isCanonicalRecord(record)) {
      // eslint-disable-next-line no-console -- intentional sink target
      console.log(renderCanonical(record, pc, plain));
      return;
    }
    const ts = new Date(record.timestamp).toISOString();
    const cat = record.category.join(".");
    const msg = record.message.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join("");
    const props = Object.keys(record.properties).length
      ? ` ${JSON.stringify(record.properties)}`
      : "";
    // eslint-disable-next-line no-console -- intentional sink target
    console.log(`${ts} ${record.level.toUpperCase()} ${cat} ${msg}${props}`);
  };
};
