/**
 * LogTape configuration entry point.
 *
 * `@logtape/logtape` ships a tiny library-first API: a global
 * `configure({ sinks, loggers })` and a `getLogger(category)` that
 * routes to the configured sinks. We expose a small wrapper so the
 * boot path can hand LogTape the built-in `"console-json"` shortcut
 * (or any custom `Sink` function — pretty rendering lives in
 * `@baerly/adapter-node` so picocolors stays off the kernel) and
 * an env-driven level override.
 *
 * The wrapper is intentionally thin: anything LogTape can do
 * (custom sinks, filters, child loggers via `getChild`) the caller
 * can do by importing LogTape directly. We add value only on the
 * defaults + env-shorthand surface.
 *
 * ## Categories
 *
 * Canonical category names live as constants ({@link CATEGORY}) so
 * downstream modules in this dispatch (and Dispatch 3+ wiring code)
 * type-check the string at the call site instead of fat-fingering
 * `"baerly.htttp"` and silently producing an unrouteable logger.
 *
 * ## Levels
 *
 * LogTape's canonical name for the warn level is `"warning"`. Our
 * config surface accepts the shorter `"warn"` because it matches
 * the rest of the project's vocabulary; we translate at the
 * configure boundary.
 *
 * ## Idempotency
 *
 * `configureObservability` is safe to call multiple times. LogTape's
 * own `configure` will reject re-configuration without `reset: true`;
 * we always pass `reset: true` so the last call wins and operators
 * can hot-swap config in dev without restarting.
 */

import {
  configure,
  getLogger as logtapeGetLogger,
  type Logger,
  type LogLevel,
  type Sink,
} from "@logtape/logtape";

/**
 * Canonical category names. Use these instead of bare strings.
 *
 * Each entry is a two-segment array (`["baerly", "<unit>"]`) so
 * LogTape's hierarchical routing — categories descend by element,
 * not by string-split — picks up the parent `"baerly"` config we
 * register in {@link configureObservability}. Passing the dotted
 * string `"baerly.http"` would create a single-element sibling
 * category and miss the parent's sink wiring.
 */
export const CATEGORY = {
  http: ["baerly", "http"],
  maintenance: ["baerly", "maintenance"],
  compactor: ["baerly", "compactor"],
  gc: ["baerly", "gc"],
  rebuild: ["baerly", "rebuild"],
  storage: ["baerly", "storage"],
} as const;

/** Logical type of a `CATEGORY.*` value. */
export type CategoryName = (typeof CATEGORY)[keyof typeof CATEGORY];

/** Friendly level names accepted by {@link configureObservability}. */
export type FriendlyLogLevel = "debug" | "info" | "warn" | "error";

/**
 * `configureObservability` configuration.
 *
 * Anything `undefined` falls back through the env-var pipeline.
 */
export interface ObservabilityConfig {
  /**
   * Lowest level that reaches the sink. Records below this level
   * are dropped. Fallback chain:
   * `config.level → LOG_LEVEL env → "info"`.
   */
  readonly level?: FriendlyLogLevel;
  /**
   * Sink shorthand or a custom LogTape {@link Sink}.
   *
   * - `"console-json"` — one JSON object per line via `console.log`.
   * - A {@link Sink} function — passed through verbatim. Adapters
   *   targeting TTY environments (e.g. `@baerly/adapter-node`'s
   *   `baerlyDev()` Vite-mount path) construct a pretty sink locally
   *   and pass it as a function; the kernel deliberately does not
   *   ship a pretty-printer to keep `picocolors` off the runtime
   *   closure.
   *
   * Default: `"console-json"`.
   */
  readonly sink?: "console-json" | Sink;
}

/**
 * Wire LogTape's global config.
 *
 * Idempotent — call as many times as you like. The adapter boot
 * path calls it once at init; tests call it once per
 * `beforeEach`.
 */
export const configureObservability = async (config: ObservabilityConfig = {}): Promise<void> => {
  const level = resolveLevel(config.level);
  const sink = resolveSink(config.sink);

  await configure({
    reset: true,
    sinks: { primary: sink },
    loggers: [
      // Bind every `baerly.*` category to our sink at the chosen level.
      { category: "baerly", sinks: ["primary"], lowestLevel: level },
      // LogTape itself logs to a meta category; route it to the same
      // sink at `error` so we see config issues without spamming.
      { category: ["logtape", "meta"], sinks: ["primary"], lowestLevel: "error" },
    ],
  });
};

/**
 * Thin re-export. Identical shape to `@logtape/logtape`'s `getLogger`.
 * Constants in {@link CATEGORY} are the canonical inputs; bare
 * strings still work for ad-hoc instrumentation.
 */
export const getLogger = (category: string | readonly string[]): Logger =>
  logtapeGetLogger(category);

// ---------- internals ----------

/** Map our friendly `"warn"` onto LogTape's canonical `"warning"`. */
const toLogTapeLevel = (l: FriendlyLogLevel): LogLevel => (l === "warn" ? "warning" : l);

const resolveLevel = (configLevel: FriendlyLogLevel | undefined): LogLevel => {
  if (configLevel !== undefined) {
    return toLogTapeLevel(configLevel);
  }
  const env = readEnv("LOG_LEVEL")?.toLowerCase();
  if (env === "debug" || env === "info" || env === "error") {
    return env;
  }
  if (env === "warn" || env === "warning") {
    return "warning";
  }
  return "info";
};

const resolveSink = (configSink: ObservabilityConfig["sink"]): Sink => {
  if (typeof configSink === "function") {
    return configSink;
  }
  return jsonConsoleSink();
};

const readEnv = (name: string): string | undefined => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.[name];
};

/**
 * Built-in JSON-line sink. Each record becomes one `console.log`
 * call with a flat object containing `timestamp`, `level`,
 * `category`, `message`, and the record's `properties`.
 */
const jsonConsoleSink = (): Sink => (record) => {
  const payload = {
    timestamp: record.timestamp,
    level: record.level,
    category: record.category.join("."),
    message: record.message.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join(""),
    ...record.properties,
  };
  // eslint-disable-next-line no-console -- intentional sink target
  console.log(JSON.stringify(payload));
};
