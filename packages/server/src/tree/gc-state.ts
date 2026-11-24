/**
 * The tree GC state at `<P>/_v99/gc-pending.json`: what GC has resolved,
 * what it still has to drain, its last reading of the storage server's
 * clock and the leak sweep's progress.
 *
 * The state records progress only. It names candidates and schedules,
 * and never authorizes a DELETE: every deletion is proven in its own
 * tick against the root that tick read (`./gc.ts`). A stale, replaced or
 * lost state can therefore leak, never delete.
 *
 * The body is the `encodeJsonBytes` of exactly this object, in this
 * field order, and is strictly decoded (fatal UTF-8, JSON, structure,
 * canonical bytes):
 *
 * ```text
 * {"format":"baerly-tree-gc-state-proto","schema_version":1,
 *  "generation":"<string>"|null, "floor_seen":h, "ticks":N,
 *  "clock":"<ISO-8601>"|null, "probed_local_at":"<ISO-8601>"|null,
 *  "resolved_through":f|null,
 *  "stuck":{"floor":f,"since":"<ISO-8601>"|null}|null,
 *  "work":[{"floor":f,"winner":"<attempt>/<sha256>","quarantined":bool,
 *           "due_at":"<ISO-8601>"|null,"next":i,
 *           "loser":{"record":"<attempt>/<sha256>","next":j}|null},...],
 *  "sweep":{"cursor":"<listed key>"|null,
 *           "marks":[{"key":"<attempt>/<sha256>","floor":h,"due_at":"<ISO-8601>"|null},...]}}
 * ```
 *
 * - `generation` and `floor_seen` bind the state to one head history.
 * - `ticks` grows on every write, so no two written bodies are equal.
 * - `clock` is the server time of the latest probe, a lower bound on
 *   server now. `probed_local_at` is the prober's local clock at that
 *   probe; it paces the next probe and is never compared with a server
 *   time.
 * - `resolved_through`: every floor at or below it is resolved or
 *   retired. `stuck` is the lowest closed floor without a unique winner.
 * - `work` holds one entry per resolved floor: the winner record's key
 *   tail, whether its list is quarantined, when its superseded nodes are
 *   due, how far it is drained, and the one loser record being drained.
 * - `sweep` holds the leak sweep's cursor and marks (noted, then
 *   stamped).
 */
import { BaerlyError, encodeJsonBytes, unsupportedSchemaVersionMessage } from "@baerly/protocol";
import {
  TREE_GC_MAX_SWEEP_MARKS,
  TREE_GC_MAX_WORK_ENTRIES,
  TREE_GC_STATE_FORMAT,
  TREE_GC_STATE_MAX_BODY_BYTES,
  TREE_GC_STATE_SCHEMA_VERSION,
} from "./constants.ts";

/** A floor GC has resolved: its winner and the loser being drained. */
export interface TreeGcWork {
  readonly floor: number;
  /** The winner record's key tail, `<attempt>/<sha256>`. */
  readonly winner: string;
  /** Whether the winner's `superseded` list is blocked from being consumed. */
  readonly quarantined: boolean;
  /** When the winner's superseded nodes are due, on the server clock; `null` until stamped. */
  readonly due_at: string | null;
  /** How many of the winner's `superseded` entries are done. */
  readonly next: number;
  /** The loser record being drained, and how many of its `fresh` entries are done. */
  readonly loser: { readonly record: string; readonly next: number } | null;
}

/** A node the leak sweep found unreachable. */
export interface TreeGcMark {
  /** The node key tail, `<attempt>/<sha256>`. */
  readonly key: string;
  /** The head floor read after the LIST that showed it. */
  readonly floor: number;
  /** When it may be deleted, on the server clock; `null` while only noted. */
  readonly due_at: string | null;
}

/** The decoded tree GC state. */
export interface TreeGcState {
  readonly generation: string | null;
  readonly floor_seen: number;
  readonly ticks: number;
  readonly clock: string | null;
  readonly probed_local_at: string | null;
  readonly resolved_through: number | null;
  readonly stuck: { readonly floor: number; readonly since: string | null } | null;
  readonly work: readonly TreeGcWork[];
  readonly sweep: { readonly cursor: string | null; readonly marks: readonly TreeGcMark[] };
}

/** The empty state bound to a head of `generation` at floor `floor`. */
export const emptyTreeGcState = (generation: string | null, floor: number): TreeGcState => ({
  generation,
  floor_seen: floor,
  ticks: 0,
  clock: null,
  probed_local_at: null,
  resolved_through: null,
  stuck: null,
  work: [],
  sweep: { cursor: null, marks: [] },
});

const REF_PATTERN = /^[0-9a-f]{32}\/[0-9a-f]{64}$/;

const isFloor = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Whether `value` is an ISO-8601 instant as `Date.prototype.toISOString` writes it. */
const isInstant = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
};

const isInstantOrNull = (value: unknown): value is string | null =>
  value === null || isInstant(value);

/** Whether `value` is a non-array object, without narrowing its declared type. */
const isObject = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The first rule `state` breaks, or `undefined`. */
const stateViolation = (state: TreeGcState): string | undefined => {
  if (state.generation !== null && typeof state.generation !== "string") {
    return "generation is neither null nor a string";
  }
  if (!isFloor(state.floor_seen) || !isFloor(state.ticks)) {
    return "floor_seen or ticks is not a non-negative safe integer";
  }
  if (!isInstantOrNull(state.clock) || !isInstantOrNull(state.probed_local_at)) {
    return "clock or probed_local_at is neither null nor an ISO-8601 instant";
  }
  if (state.resolved_through !== null && !isFloor(state.resolved_through)) {
    return "resolved_through is neither null nor a floor";
  }
  if (
    state.stuck !== null &&
    (!isObject(state.stuck) || !isFloor(state.stuck.floor) || !isInstantOrNull(state.stuck.since))
  ) {
    return "stuck is malformed";
  }
  if (!Array.isArray(state.work) || state.work.length > TREE_GC_MAX_WORK_ENTRIES) {
    return "work is not a list within its cap";
  }
  for (const entry of state.work) {
    if (
      !isObject(entry) ||
      !isFloor(entry.floor) ||
      typeof entry.winner !== "string" ||
      !REF_PATTERN.test(entry.winner) ||
      typeof entry.quarantined !== "boolean" ||
      !isInstantOrNull(entry.due_at) ||
      !isFloor(entry.next) ||
      (entry.loser !== null &&
        (!isObject(entry.loser) ||
          typeof entry.loser.record !== "string" ||
          !REF_PATTERN.test(entry.loser.record) ||
          !isFloor(entry.loser.next)))
    ) {
      return "a work entry is malformed";
    }
  }
  if (!state.work.every((entry, i) => i === 0 || state.work[i - 1]!.floor < entry.floor)) {
    return "work entries are not in strictly increasing floor order";
  }
  const sweep = state.sweep;
  if (
    !isObject(sweep) ||
    (sweep.cursor !== null && typeof sweep.cursor !== "string") ||
    !Array.isArray(sweep.marks) ||
    sweep.marks.length > TREE_GC_MAX_SWEEP_MARKS
  ) {
    return "sweep is malformed";
  }
  for (const mark of sweep.marks) {
    if (
      !isObject(mark) ||
      typeof mark.key !== "string" ||
      !REF_PATTERN.test(mark.key) ||
      !isFloor(mark.floor) ||
      !isInstantOrNull(mark.due_at)
    ) {
      return "a sweep mark is malformed";
    }
  }
  if (new Set(sweep.marks.map((mark) => mark.key)).size !== sweep.marks.length) {
    return "a sweep mark repeats a key";
  }
  return undefined;
};

/** The canonical body of `state`, fields in format order. */
const encodeBody = (state: TreeGcState): Uint8Array =>
  encodeJsonBytes({
    format: TREE_GC_STATE_FORMAT,
    schema_version: TREE_GC_STATE_SCHEMA_VERSION,
    generation: state.generation,
    floor_seen: state.floor_seen,
    ticks: state.ticks,
    clock: state.clock,
    probed_local_at: state.probed_local_at,
    resolved_through: state.resolved_through,
    stuck: state.stuck === null ? null : { floor: state.stuck.floor, since: state.stuck.since },
    work: state.work.map((entry) => ({
      floor: entry.floor,
      winner: entry.winner,
      quarantined: entry.quarantined,
      due_at: entry.due_at,
      next: entry.next,
      loser: entry.loser === null ? null : { record: entry.loser.record, next: entry.loser.next },
    })),
    sweep: {
      cursor: state.sweep.cursor,
      marks: state.sweep.marks.map((mark) => ({
        key: mark.key,
        floor: mark.floor,
        due_at: mark.due_at,
      })),
    },
  });

/**
 * Encode `state`. A state the decoder would refuse is never encoded.
 *
 * @throws BaerlyError code="Internal" — the state breaks a state rule
 *   (a GC bug).
 */
export const encodeTreeGcState = (state: TreeGcState): Uint8Array => {
  const violation = stateViolation(state);
  if (violation !== undefined) {
    throw new BaerlyError("Internal", `tree GC state: ${violation}`);
  }
  const bytes = encodeBody(state);
  if (bytes.byteLength > TREE_GC_STATE_MAX_BODY_BYTES) {
    throw new BaerlyError("Internal", `tree GC state: the body is over its ceiling`);
  }
  return bytes;
};

/** What a state read decodes to. */
export type TreeGcStateDecode =
  | { readonly kind: "state"; readonly state: TreeGcState }
  | { readonly kind: "malformed"; readonly reason: string };

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const malformed = (reason: string): TreeGcStateDecode => ({ kind: "malformed", reason });

/**
 * Strictly decode the state body `bytes` read from `key`. A malformed
 * state is a value, because GC replaces it leak-only; only a state of
 * this format with a `schema_version` this build does not know throws.
 *
 * @throws BaerlyError code="InvalidResponse" — the state has this
 *   format and an unknown `schema_version`: it was written by another
 *   release, so GC for this collection is paused.
 */
export const decodeTreeGcState = (key: string, bytes: Uint8Array): TreeGcStateDecode => {
  if (bytes.byteLength > TREE_GC_STATE_MAX_BODY_BYTES) {
    return malformed("the body is over its ceiling");
  }
  let value: unknown;
  try {
    value = JSON.parse(fatalUtf8.decode(bytes));
  } catch {
    return malformed("the body is not UTF-8 JSON");
  }
  if (!isPlainObject(value) || value["format"] !== TREE_GC_STATE_FORMAT) {
    return malformed("the body is not a tree GC state");
  }
  const version = value["schema_version"];
  if (typeof version !== "number") {
    return malformed("schema_version is not a number");
  }
  if (version !== TREE_GC_STATE_SCHEMA_VERSION) {
    throw new BaerlyError(
      "InvalidResponse",
      `${unsupportedSchemaVersionMessage(
        `tree GC state ${JSON.stringify(key)}`,
        version,
        TREE_GC_STATE_SCHEMA_VERSION,
      )} GC for this collection was written by a newer release and is paused.`,
      { resolution: "Run the app or operator CLI at that release or later." },
    );
  }
  const state: TreeGcState = {
    generation: value["generation"] as TreeGcState["generation"],
    floor_seen: value["floor_seen"] as number,
    ticks: value["ticks"] as number,
    clock: value["clock"] as TreeGcState["clock"],
    probed_local_at: value["probed_local_at"] as TreeGcState["probed_local_at"],
    resolved_through: value["resolved_through"] as TreeGcState["resolved_through"],
    stuck: value["stuck"] as TreeGcState["stuck"],
    work: value["work"] as TreeGcState["work"],
    sweep: value["sweep"] as TreeGcState["sweep"],
  };
  const violation = stateViolation(state);
  if (violation !== undefined) {
    return malformed(violation);
  }
  const canonical = encodeBody(state);
  if (canonical.byteLength !== bytes.byteLength || !canonical.every((b, i) => b === bytes[i])) {
    return malformed("the body is not the canonical encoding of its value");
  }
  return { kind: "state", state };
};
