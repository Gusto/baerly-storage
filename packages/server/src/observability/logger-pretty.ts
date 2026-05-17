/**
 * Pretty console sink for the `baerly dev` boot path.
 *
 * Lives in its own module so consumers that select the default
 * `"console-json"` sink (production Workers, headless Node) never
 * pull `picocolors` or the canonical-line column renderer into
 * their bundle. `logger.ts` reaches this module via
 * `await import("./logger-pretty.ts")` only when the chosen sink
 * is `"console-pretty"`.
 *
 * Bundle-size note: the static-import scanner in
 * `tests/integration/bundle-size.test.ts` skips `import("...")`,
 * so the chunk rolldown emits for this file is excluded from the
 * kernel / http / observability / maintenance entry budgets.
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
  wamp: "db.write.class_a_ops_per_logical_write_p99",
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

const renderCanonical = (record: LogRecord, pc: PicoColors, plain: boolean): string => {
  const props = record.properties as Record<string, unknown>;
  const ts = new Date(record.timestamp).toISOString().slice(11, 19);
  const reqId = String(pickProp(props, "request_id") ?? "").slice(0, 8);
  const duration = numProp(props, "duration_ms") ?? 0;
  const durationStr = `${Math.round(duration)}ms`.padStart(5);

  const status = numProp(props, "status");
  const method = pickProp(props, "method");
  const path = pickProp(props, "path");

  let prefix: string;
  if (typeof method === "string" && typeof path === "string") {
    const m = method.padEnd(METHOD_W);
    const p = path.length > PATH_W ? `${path.slice(0, PATH_W - 1)}…` : path.padEnd(PATH_W);
    const statusStr = status === undefined ? "   " : String(status);
    const coloredStatus =
      plain || status === undefined
        ? statusStr
        : status >= 500
          ? pc.red(statusStr)
          : status >= 400
            ? pc.yellow(statusStr)
            : status >= 300
              ? pc.cyan(statusStr)
              : pc.dim(statusStr);
    prefix = `${m}${p}  ${coloredStatus}  ${durationStr}`;
  } else {
    const unit = record.category.join(".").replace(/^baerly\./, "");
    const icon = plain ? "* " : "⚙ ";
    const head = `${icon}${unit}`.padEnd(METHOD_W + PATH_W);
    prefix = `${head}      ${durationStr}`;
  }

  const tail: string[] = [];
  if (reqId) tail.push(`req=${reqId}`);
  const classA = numProp(props, CANONICAL_KEYS.classA);
  const classB = numProp(props, CANONICAL_KEYS.classB);
  if (classA !== undefined) tail.push(`class_a=${classA}`);
  if (classB !== undefined) tail.push(`class_b=${classB}`);
  const wamp = numProp(props, CANONICAL_KEYS.wamp);
  if (wamp !== undefined) tail.push(`wamp=${wamp}`);
  const c412 = numProp(props, CANONICAL_KEYS.put412);
  if (c412 !== undefined && c412 > 0) tail.push(`412=${c412}`);
  const c429 = numProp(props, CANONICAL_KEYS.put429);
  if (c429 !== undefined && c429 > 0) tail.push(`429=${c429}`);
  const cacheStatus = pickProp(props, CANONICAL_KEYS.cacheStatus);
  if (typeof cacheStatus === "string") tail.push(`cache=${cacheStatus}`);
  if (status !== undefined && status >= 400) {
    const outcome = pickProp(props, "outcome");
    if (typeof outcome === "string") tail.push(`outcome=${outcome}`);
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
 * in `./canonical.ts`) in a column-aligned cost-aware format
 * intended for `baerly dev`; falls back to a generic
 * `<ts> <LEVEL> <category> <msg> <jsonProps>` layout for every
 * other record (warn-line `verifier_rejected`, debug storage
 * emits, etc.).
 *
 * Color is enabled when stderr is a TTY and `CI` is unset. Under
 * vitest, stderr is non-TTY so color is off — tests can assert
 * substring matches without stripping ANSI escapes. Workers
 * Runtime is also non-TTY so the plain layout ships there too.
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
