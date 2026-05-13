/**
 * LogTape configuration entry point.
 *
 * `@logtape/logtape` ships a tiny library-first API: a global
 * `configure({ sinks, loggers })` and a `getLogger(category)` that
 * routes to the configured sinks. We expose a small wrapper so the
 * boot path can hand LogTape a `"console-json"` /
 * `"console-pretty"` shortcut and an env-driven level override.
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
  writer: ["baerly", "writer"],
  maintenance: ["baerly", "maintenance"],
  compactor: ["baerly", "compactor"],
  gc: ["baerly", "gc"],
  rebuild: ["baerly", "rebuild"],
  storage: ["baerly", "storage"],
  auth: ["baerly", "auth"],
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
   * - `"console-pretty"` — human-readable text with the same
   *   information; intended for `baerly dev`.
   * - A {@link Sink} function — passed through verbatim.
   *
   * Default: `"console-json"`.
   */
  readonly sink?: "console-json" | "console-pretty" | Sink;
  /**
   * Head-based sample rate in `[0, 1]`. Cached for
   * {@link getEffectiveSampleRate}; the canonical-line flusher
   * reads it via that getter rather than re-parsing on every call.
   * Fallback chain: `config.sampleRate → LOG_SAMPLE env → 1.0`.
   */
  readonly sampleRate?: number;
}

/**
 * Cached after the last successful `configureObservability` call.
 * `0` (never sample) is a valid value, so we sentinel "unset" with
 * `null`. The canonical-line flusher reads via
 * {@link getEffectiveSampleRate} which defaults to `1.0`.
 */
let effectiveSampleRate: number | null = null;

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

  effectiveSampleRate = resolveSampleRate(config.sampleRate);
};

/** Returns the cached sample rate, or `1.0` if config hasn't been wired yet. */
export const getEffectiveSampleRate = (): number =>
  effectiveSampleRate ?? resolveSampleRate(undefined);

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
  if (configLevel !== undefined) return toLogTapeLevel(configLevel);
  const env = readEnv("LOG_LEVEL")?.toLowerCase();
  if (env === "debug" || env === "info" || env === "error") return env;
  if (env === "warn" || env === "warning") return "warning";
  return "info";
};

const resolveSink = (configSink: ObservabilityConfig["sink"]): Sink => {
  if (typeof configSink === "function") return configSink;
  const choice = configSink ?? "console-json";
  return choice === "console-pretty" ? prettyConsoleSink() : jsonConsoleSink();
};

const resolveSampleRate = (configRate: number | undefined): number => {
  if (configRate !== undefined) return clampRate(configRate);
  const env = readEnv("LOG_SAMPLE");
  if (env === undefined) return 1.0;
  const parsed = Number(env);
  return Number.isFinite(parsed) ? clampRate(parsed) : 1.0;
};

const clampRate = (r: number): number => Math.max(0, Math.min(1, r));

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

/**
 * Built-in pretty sink. Human-readable text; no colors (oxlint
 * doesn't ship a color util and ANSI escapes on a non-TTY are
 * worse than no colors at all). Workers Runtime's stdout shim
 * accepts `console.log` too — no platform check needed.
 */
const prettyConsoleSink = (): Sink => (record) => {
  const ts = new Date(record.timestamp).toISOString();
  const cat = record.category.join(".");
  const msg = record.message.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join("");
  const props = Object.keys(record.properties).length
    ? ` ${JSON.stringify(record.properties)}`
    : "";
  // eslint-disable-next-line no-console -- intentional sink target
  console.log(`${ts} ${record.level.toUpperCase()} ${cat} ${msg}${props}`);
};
