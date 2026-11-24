/**
 * The tree GC tick: reclaim the tree nodes no current root reaches,
 * without ever writing the head.
 *
 * Every publication attempt writes a fold record before its first node
 * (`./record.ts`), keyed by the floor of the head it captured. A
 * record's floor is **closed** once the head's `log_seq_start` is above
 * it: floors never decrease within one head history, so the head that
 * attempt captured never returns and its head CAS can no longer land.
 * At most one attempt per floor published; GC names it from storage
 * evidence the winning CAS created (the head's `proto_tree.attempt`, or
 * the `base.attempt` of a record captured on a later floor), and every
 * other attempt recorded at that floor is a loser.
 *
 * - A loser's fresh nodes are deleted at once: its root was never
 *   installed, so nothing ever read them.
 * - A winner's superseded nodes are deleted
 *   `TREE_GC_SUPERSEDED_DELAY_MINUTES` after a probe of the storage
 *   server's clock first stamps them, so reads through the replaced
 *   root can finish. The delay is a margin, not a proof: a read that
 *   outlives it meets the reader's missing-node backstop. A winner
 *   whose identity shows up in another record is quarantined: none of
 *   its superseded nodes is deleted, and once its floor's loser is done
 *   its record is retired leak-only.
 * - A slow leak sweep lists the node prefix a page per probe and
 *   deletes nodes that are unreachable, whose attempt can no longer
 *   publish (a later fold moved the floor past the one read after the
 *   listing), and that stayed so for `TREE_GC_SWEEP_AGE_MINUTES`.
 *
 * Every DELETE is proven in its own tick by the membership check of
 * `./gc-member.ts` against the root of the head that tick read. Records,
 * the state and the clock only nominate and pace; none authorizes a
 * deletion, so a stale or lost state can leak and never delete. No
 * DELETE, of a node or a record, is issued before the tick's probe CAS
 * has won: a tick that loses it deletes nothing.
 *
 * **State.** `<P>/_v99/gc-pending.json` (`./gc-state.ts`) holds
 * progress, bound to the head's `generation` and floor. A state of
 * another history, or a malformed one, is replaced leak-only by the
 * empty state; one that names another format or schema version, which
 * may be a newer release's, stops the tick with `InvalidResponse` and is
 * left as it is.
 *
 * **Clock.** The only clock is the `serverDate` of GC's own state write.
 * A tick probes it (a state CAS) at most once per
 * `TREE_GC_CLOCK_PROBE_MINUTES` of local time, judged only against the
 * local time of the previous probe. Due tests use that probe's server
 * time, or the last one between probes. A probe that reports no server
 * time stamps nothing and makes nothing due.
 *
 * **Tick.** Only a probe tick collects, so GC's LISTs and DELETEs run
 * at most once per probe interval, whatever the write rate. Any other
 * tick is a state GET and then `retireLogRange`. A probe tick: state
 * GET; the sweep LIST; head GET; root GET; record LIST; resolve closed
 * floors, queueing the record retirements that chooses; the probe
 * write; the queued retirements; checks and DELETEs (active losers'
 * fresh nodes, due winners' superseded nodes, due sweep marks); the
 * sweep's notes and stamps; the state write, only when something
 * changed; then `retireLogRange`. Every DELETE follows that tick's record LIST, which
 * the identity checks are drawn from. Candidate checks per tick are
 * sized from the request ledger.
 */
import {
  BaerlyError,
  currentRequestLedger,
  GC_MARK_LIST_PAGE_KEYS,
  isWriteConflict,
  type Storage,
} from "@baerly/protocol";
import { retireLogRange } from "../log-retention.ts";
import { ctxMetrics, getCurrentContext } from "../observability/context.ts";
import {
  TREE_GC_CLOCK_PROBE_MINUTES,
  TREE_GC_MAX_SWEEP_MARKS,
  TREE_GC_MAX_WORK_ENTRIES,
  TREE_GC_SUPERSEDED_DELAY_MINUTES,
  TREE_GC_SWEEP_AGE_MINUTES,
  TREE_GC_SWEEP_LIST_KEYS,
  TREE_GC_TICK_CANDIDATES,
  TREE_GC_TICK_MAX_CANDIDATES,
  TREE_GC_TICK_RECORD_CALLS,
  TREE_GC_TICK_RESERVED_CALLS,
  TREE_RETRIED_CALL_CHARGE,
} from "./constants.ts";
import { createTreeGcRootView, type TreeGcMembership, treeGcMembership } from "./gc-member.ts";
import {
  decodeTreeGcState,
  emptyTreeGcState,
  encodeTreeGcState,
  type TreeGcMark,
  type TreeGcState,
  type TreeGcWork,
} from "./gc-state.ts";
import { readTreeHead, readTreeRoot, treeHeadKey, type TreeHead } from "./head.ts";
import {
  collectionOfPrefix,
  parseTreeNodeKey,
  parseTreeRecordKey,
  treeGcStateKey,
  treeNodeKeyPrefix,
  treeRecordKey,
  treeRecordKeyPrefix,
} from "./key.ts";
import { bytesEqual, DEFAULT_TREE_CONFIG, type TreeConfig } from "./layout.ts";
import { decodeFoldRecord, type FoldRecord } from "./record.ts";

const STATE_CONTENT_TYPE = "application/json";
const MINUTE_MS = 60_000;

/** The winner and losers among the attempts recorded at one closed floor. */
export interface TreeGcClassification {
  /** The winning attempt, or `null` when the evidence names no unique one. */
  readonly winner: string | null;
  /** Attempts whose fresh nodes are deleted; empty without a winner. */
  readonly losers: readonly string[];
  /** The evidence named more than one member. */
  readonly ambiguous: boolean;
}

/**
 * Classify the attempts recorded at one closed floor: the winner is the
 * unique member the evidence names, every other member a loser. An
 * attempt that appears in more than one listed record is neither.
 */
export const classifyFloor = (
  members: readonly string[],
  evidence: ReadonlySet<string>,
  duplicates: ReadonlySet<string>,
): TreeGcClassification => {
  const eligible = members.filter((attempt) => !duplicates.has(attempt));
  const named = eligible.filter((attempt) => evidence.has(attempt));
  if (named.length !== 1) {
    return { winner: null, losers: [], ambiguous: named.length > 1 };
  }
  const winner = named[0]!;
  return { winner, losers: eligible.filter((attempt) => attempt !== winner), ambiguous: false };
};

/**
 * Whether GC may delete by attempt `attempt`: not when it appears in
 * more than one listed record (an identity reused), nor while it has a
 * record on an open floor (it may still publish and adopt its keys).
 */
export const trustsIdentity = (
  attempt: string,
  duplicates: ReadonlySet<string>,
  open: ReadonlySet<string>,
): boolean => !duplicates.has(attempt) && !open.has(attempt);

/** Whether `dueAt` is at or before server time `now`; nothing is due without both. */
export const isDueAt = (dueAt: string | null, now: Date | undefined): boolean =>
  dueAt !== null && now !== undefined && Date.parse(dueAt) <= now.getTime();

/** Whether the state as read belongs to `head`'s history: same generation, no floor regression. */
export const stateBindsHead = (state: TreeGcState, head: TreeHead): boolean =>
  state.generation === (head.json.generation ?? null) &&
  state.floor_seen <= head.json.log_seq_start;

/**
 * Whether a tick probes the server clock, by local time alone: the
 * first probe, at least `TREE_GC_CLOCK_PROBE_MINUTES` after the last,
 * or when the local clock reads earlier than the last probe's.
 */
export const probeIsDue = (probedLocalAt: string | null, local: Date): boolean => {
  if (probedLocalAt === null) {
    return true;
  }
  const last = Date.parse(probedLocalAt);
  return (
    local.getTime() < last || local.getTime() - last >= TREE_GC_CLOCK_PROBE_MINUTES * MINUTE_MS
  );
};

interface GcSteps {
  readonly isMember: NonNullable<TreeConfig["steps"]["gcIsMember"]>;
  readonly onCorrupt: NonNullable<TreeConfig["steps"]["gcOnCorrupt"]>;
  readonly parsesKey: NonNullable<TreeConfig["steps"]["gcParsesKey"]>;
  readonly classify: NonNullable<TreeConfig["steps"]["gcClassify"]>;
  readonly isClosed: NonNullable<TreeConfig["steps"]["gcIsClosed"]>;
  readonly isDue: NonNullable<TreeConfig["steps"]["gcIsDue"]>;
  readonly now: NonNullable<TreeConfig["steps"]["gcNow"]>;
  readonly bindsHead: NonNullable<TreeConfig["steps"]["gcBindsHead"]>;
  readonly sweepIsMember: NonNullable<TreeConfig["steps"]["sweepIsMember"]>;
  readonly passesFloorGate: NonNullable<TreeConfig["steps"]["sweepPassesFloorGate"]>;
  readonly startsAge: NonNullable<TreeConfig["steps"]["sweepStartsAge"]>;
  readonly listsBeforeHead: NonNullable<TreeConfig["steps"]["sweepListsBeforeHead"]>;
  readonly trustsIdentity: NonNullable<TreeConfig["steps"]["gcTrustsIdentity"]>;
  readonly retiresBeforeProbe: NonNullable<TreeConfig["steps"]["gcRetiresBeforeProbe"]>;
}

const gcSteps = (config: TreeConfig): GcSteps => {
  const s = config.steps;
  const isMember = s.gcIsMember ?? treeGcMembership;
  return {
    isMember,
    onCorrupt: s.gcOnCorrupt ?? ((role, guardHolds) => role === "loser" && guardHolds),
    parsesKey: s.gcParsesKey ?? parseTreeNodeKey,
    classify: s.gcClassify ?? classifyFloor,
    isClosed: s.gcIsClosed ?? ((floor, headFloor) => floor < headFloor),
    isDue: s.gcIsDue ?? isDueAt,
    now: s.gcNow ?? ((serverDate) => serverDate),
    bindsHead: s.gcBindsHead ?? stateBindsHead,
    sweepIsMember: s.sweepIsMember ?? ((x, view) => isMember(x, view)),
    passesFloorGate: s.sweepPassesFloorGate ?? ((markFloor, headFloor) => headFloor > markFloor),
    startsAge: s.sweepStartsAge ?? ((phase) => phase === "stamp"),
    listsBeforeHead: s.sweepListsBeforeHead ?? (() => true),
    trustsIdentity: s.gcTrustsIdentity ?? trustsIdentity,
    retiresBeforeProbe: s.gcRetiresBeforeProbe ?? (() => false),
  };
};

/** Input to {@link runTreeGcTick}. */
export interface TreeGcInput {
  /** Storage behind the adapter retry (`retryStorageCall`). */
  readonly storage: Storage;
  /** The collection prefix `P`. */
  readonly prefix: string;
  /** The tree configuration; tests pass a mutant here. */
  readonly config?: TreeConfig;
  /** The local clock; it only paces probes. Default `new Date()`. */
  readonly now?: () => Date;
  /** Test seam for `retireLogRange`'s sequence window; production omits it. */
  readonly retireWindow?: number;
  readonly signal?: AbortSignal;
}

/** What one GC tick did. */
export interface TreeGcTickResult {
  /**
   * - `collected`: the tick ran to its end;
   * - `no-head`: the collection has no head yet;
   * - `reset`: the state was malformed or of another head history, and
   *   was replaced by the empty state;
   * - `paced`: no probe was due, so the tick only retired the log;
   * - `budget`: the request ledger had no room for one candidate check;
   * - `conflict`: the probe write lost, so the tick deleted nothing.
   */
  readonly outcome: "collected" | "paced" | "no-head" | "reset" | "budget" | "conflict";
  /** Every key the tick deleted, nodes and records, in order. */
  readonly deleted: readonly string[];
  /** The probe's server time, when the tick probed and storage reported one. */
  readonly serverTime: Date | undefined;
  /** Whether the tick probed. */
  readonly probed: boolean;
  /** Candidate checks the tick could make. */
  readonly candidates: number;
}

/** A record key the tick listed. */
interface ListedRecord {
  readonly key: string;
  readonly floor: number;
  readonly attempt: string;
  /** `<attempt>/<sha256>`. */
  readonly tail: string;
}

const addMinutes = (instant: Date, minutes: number): string =>
  new Date(instant.getTime() + minutes * MINUTE_MS).toISOString();

/** Calls one candidate check may cost at root level `depth`: its DELETE and membership GETs. */
export const treeGcCandidateCharge = (depth: number): number =>
  depth <= 1 ? TREE_RETRIED_CALL_CHARGE : TREE_RETRIED_CALL_CHARGE * (depth + 1);

/**
 * Candidate checks a tick may make at root level `depth` with `left`
 * ledger calls remaining: `TREE_GC_TICK_MAX_CANDIDATES` when the ledger
 * has room for that many, else at most `TREE_GC_TICK_CANDIDATES`, and
 * never more than fit after the tick's other calls.
 */
export const treeGcCandidates = (depth: number, left: number): number => {
  const room = Math.floor((left - TREE_GC_TICK_RESERVED_CALLS) / treeGcCandidateCharge(depth));
  const max =
    room >= TREE_GC_TICK_MAX_CANDIDATES ? TREE_GC_TICK_MAX_CANDIDATES : TREE_GC_TICK_CANDIDATES;
  return Math.max(0, Math.min(max, room));
};

const warn = (code: string, fields: Record<string, unknown>, detail: string): void => {
  const sink = getCurrentContext()?.maintenance?.warn;
  if (sink !== undefined) {
    try {
      sink(code, { ...fields, detail });
      return;
    } catch {
      // Fall through to the console line.
    }
  }
  console.warn(detail);
};

/** Whether two states are equal apart from `floor_seen`, which alone is no reason to write. */
const sameState = (a: TreeGcState, b: TreeGcState): boolean =>
  bytesEqual(
    encodeTreeGcState({ ...a, floor_seen: 0 }),
    encodeTreeGcState({ ...b, floor_seen: 0 }),
  );

const isUnknownFate = (error: unknown): boolean =>
  isWriteConflict(error) || (error instanceof BaerlyError && error.code === "NetworkError");

/**
 * Run one tree GC tick over the collection at `input.prefix`. See the
 * module comment.
 *
 * @throws BaerlyError code="InvalidResponse" — the head or root is not a
 *   valid tree, or the GC state names a format or schema version this
 *   build does not read.
 * @throws BaerlyError — a storage call fails, with its code. A lost
 *   state write is an outcome, not an error.
 */
export const runTreeGcTick = async (input: TreeGcInput): Promise<TreeGcTickResult> => {
  const { storage, prefix, signal } = input;
  const config = input.config ?? DEFAULT_TREE_CONFIG;
  const steps = gcSteps(config);
  const collection = collectionOfPrefix(prefix);
  const local = (input.now ?? (() => new Date()))();
  const opts = signal === undefined ? undefined : { signal };
  const stateKey = treeGcStateKey(prefix);
  const nodePrefix = treeNodeKeyPrefix(prefix);
  const counter = (name: string, value = 1): void => {
    if (value > 0) {
      ctxMetrics().counter(`db.tree_gc.${name}`, value, { collection });
    }
  };
  const deleted: string[] = [];
  const end = (
    outcome: TreeGcTickResult["outcome"],
    extra: Partial<TreeGcTickResult> = {},
  ): TreeGcTickResult => ({
    outcome,
    deleted,
    serverTime: undefined,
    probed: false,
    candidates: 0,
    ...extra,
  });

  const putState = async (state: TreeGcState, etag: string | null) =>
    storage.put(stateKey, encodeTreeGcState(state), {
      ...(etag === null ? { ifNoneMatch: "*" as const } : { ifMatch: etag }),
      contentType: STATE_CONTENT_TYPE,
      ...(signal !== undefined && { signal }),
    });

  // 1. The state.
  const got = await storage.get(stateKey, opts);
  const decoded = got === null ? null : decodeTreeGcState(stateKey, got.body);
  const e0 = got?.etag ?? null;
  const read = decoded?.kind === "state" ? decoded.state : null;

  const retire = async (): Promise<void> => {
    try {
      await retireLogRange(storage, treeHeadKey(prefix), {
        ...(signal !== undefined && { signal }),
        ...(input.retireWindow !== undefined && { window: input.retireWindow }),
      });
    } catch (error) {
      if (!isWriteConflict(error)) {
        throw error;
      }
    }
  };

  // 2. Pacing: only a probe tick collects. A malformed state goes on to
  // be reset, which needs the head.
  const probe = decoded?.kind !== "malformed" && probeIsDue(read?.probed_local_at ?? null, local);
  if (!probe && decoded?.kind !== "malformed") {
    await retire();
    return end("paced");
  }

  // The sweep page, listed before the head unless a mutant moves it.
  const listed: string[] = [];
  const listSweep = async (cursor: string | null): Promise<void> => {
    for await (const entry of storage.list(nodePrefix, {
      ...(cursor !== null && { startAfter: cursor }),
      maxKeys: TREE_GC_SWEEP_LIST_KEYS,
      ...(signal !== undefined && { signal }),
    })) {
      listed.push(entry.key);
    }
  };
  if (probe && steps.listsBeforeHead()) {
    await listSweep(read?.sweep.cursor ?? null);
  }

  // 3. The head.
  const head = await readTreeHead(storage, prefix, opts);
  if (head === null) {
    return end("no-head");
  }
  if (probe && !steps.listsBeforeHead()) {
    await listSweep(read?.sweep.cursor ?? null);
  }
  const h = head.json.log_seq_start;
  const generation = head.json.generation ?? null;
  if (decoded?.kind === "malformed" || (read !== null && !steps.bindsHead(read, head))) {
    try {
      await putState(emptyTreeGcState(generation, h), e0);
    } catch (error) {
      if (!isUnknownFate(error)) {
        throw error;
      }
    }
    return end("reset");
  }
  const base: TreeGcState = read ?? emptyTreeGcState(generation, h);

  // 4. The root, and the candidate budget it implies.
  const root = await readTreeRoot(storage, head, config, opts);
  const depth = root?.node.level ?? 0;
  const candidates = treeGcCandidates(
    depth,
    currentRequestLedger()?.storageRemaining() ?? Number.POSITIVE_INFINITY,
  );
  if (candidates < 1) {
    ctxMetrics().counter("db.maintenance.request_budget_skipped_total", 1, {
      collection,
      phase: "gc",
    });
    return end("budget");
  }

  // 5. The record page.
  const records: ListedRecord[] = [];
  let recordPageFull = false;
  for await (const entry of storage.list(treeRecordKeyPrefix(prefix), {
    maxKeys: GC_MARK_LIST_PAGE_KEYS,
    ...(signal !== undefined && { signal }),
  })) {
    const parts = parseTreeRecordKey(prefix, entry.key);
    if (parts === null) {
      counter("unknown_key_total");
      continue;
    }
    records.push({
      key: entry.key,
      floor: parts.floor,
      attempt: parts.attempt,
      tail: `${parts.attempt}/${parts.sha256}`,
    });
  }
  recordPageFull = records.length >= GC_MARK_LIST_PAGE_KEYS;
  const lastListedFloor = records.at(-1)?.floor ?? -1;
  /** Whether the record page shows every record at `floor`. */
  const pageCovers = (floor: number): boolean => !recordPageFull || lastListedFloor > floor;

  const seen = new Map<string, number>();
  for (const record of records) {
    seen.set(record.attempt, (seen.get(record.attempt) ?? 0) + 1);
  }
  const duplicates = new Set([...seen].filter(([, n]) => n > 1).map(([attempt]) => attempt));
  if (duplicates.size > 0) {
    counter("duplicate_attempt_total", duplicates.size);
    warn(
      "tree_gc_duplicate_attempt",
      { collection, attempts: [...duplicates] },
      `tree GC of collection ${JSON.stringify(collection)}: ${duplicates.size} publication identities each appear in more than one fold record; those records are retired without deleting any node they name.`,
    );
  }

  // Record GETs and DELETEs share one cap each per tick.
  let probeWon = false;
  let recordGets = TREE_GC_TICK_RECORD_CALLS;
  let recordDeletes = TREE_GC_TICK_RECORD_CALLS;
  const retired = new Set<string>();
  const fetched = new Map<string, FoldRecord | "absent" | "unusable">();
  /** A verified record of this generation, `absent`, `unusable` (retire it) or `budget`. */
  const recordAt = async (key: string): Promise<FoldRecord | "absent" | "unusable" | "budget"> => {
    const known = fetched.get(key);
    if (known !== undefined) {
      return known;
    }
    if (recordGets <= 0) {
      return "budget";
    }
    recordGets -= 1;
    const body = await storage.get(key, opts);
    let result: FoldRecord | "absent" | "unusable";
    if (body === null) {
      result = "absent";
    } else {
      try {
        const record = await decodeFoldRecord(prefix, key, body.body);
        result = record.base.generation === base.generation ? record : "unusable";
      } catch (error) {
        if (!(error instanceof BaerlyError) || error.code !== "InvalidResponse") {
          throw error;
        }
        counter("corrupt_record_total");
        warn(
          "tree_gc_corrupt_record",
          { collection, key },
          `tree GC of collection ${JSON.stringify(collection)}: fold record ${key} does not match its key or does not parse; it is retired without deleting any node it names.`,
        );
        result = "unusable";
      }
    }
    fetched.set(key, result);
    return result;
  };
  /**
   * Record retirements chosen before the probe, issued only once the
   * probe CAS has won: a tick that loses it deletes nothing.
   */
  const queuedRetirements: string[] = [];
  /**
   * Retire a record without deleting any node it names, under the
   * per-tick cap; false when the cap is spent. Before the probe it only
   * queues the DELETE.
   */
  const retireRecord = async (key: string): Promise<boolean> => {
    if (retired.has(key)) {
      return true;
    }
    if (recordDeletes <= 0) {
      return false;
    }
    recordDeletes -= 1;
    retired.add(key);
    if (!probeWon && !steps.retiresBeforeProbe()) {
      queuedRetirements.push(key);
      return true;
    }
    await storage.delete(key, opts);
    deleted.push(key);
    return true;
  };
  const recordKeyOf = (floor: number, tail: string): string =>
    treeRecordKey(prefix, floor, tail.slice(0, 32), tail.slice(33));

  // 6. Resolve closed floors in order.
  const floors = new Map<number, ListedRecord[]>();
  for (const record of records) {
    floors.set(record.floor, [...(floors.get(record.floor) ?? []), record]);
  }
  const order = [...floors.keys()].toSorted((a, b) => a - b);
  const evidence = new Set<string>(head.attempt === null ? [] : [head.attempt]);
  // An identity found in two records, or one still publishing on an open
  // floor, is never a deletion source: a later attempt may hold its keys.
  const open = new Set(
    records.filter((record) => !steps.isClosed(record.floor, h)).map((r) => r.attempt),
  );
  const deletable = (attempt: string): boolean => steps.trustsIdentity(attempt, duplicates, open);
  const untrusted = new Set([...duplicates].filter((attempt) => !deletable(attempt)));
  const work: TreeGcWork[] = base.work.map((entry) => {
    const quarantined = entry.quarantined || !deletable(entry.winner.slice(0, 32));
    const loser =
      entry.loser !== null && deletable(entry.loser.record.slice(0, 32)) ? entry.loser : null;
    return { ...entry, quarantined, loser };
  });
  let resolvedThrough = base.resolved_through;
  let stuck = base.stuck;
  const lastClock = base.clock === null ? undefined : new Date(base.clock);
  for (const [i, floor] of order.entries()) {
    if (!steps.isClosed(floor, h)) {
      break;
    }
    const members = floors.get(floor)!.filter((record) => !retired.has(record.key));
    const at = work.findIndex((entry) => entry.floor === floor);
    if (at >= 0) {
      const entry = work[at]!;
      if (entry.loser === null) {
        const { losers } = steps.classify(
          members.map((record) => record.attempt),
          new Set([...evidence, entry.winner.slice(0, 32)]),
          untrusted,
        );
        const loser = members.find(
          (record) => record.tail !== entry.winner && losers.includes(record.attempt),
        );
        if (loser !== undefined) {
          work[at] = { ...entry, loser: { record: loser.tail, next: 0 } };
        }
      }
      continue;
    }
    if (resolvedThrough !== null && floor <= resolvedThrough) {
      // Stale: resolved before, and no entry covers it.
      for (const record of members) {
        await retireRecord(record.key);
      }
      continue;
    }
    if (work.length >= TREE_GC_MAX_WORK_ENTRIES) {
      break;
    }
    const next = order[i + 1];
    const witness = next === undefined ? undefined : floors.get(next)![0];
    if (witness !== undefined && !retired.has(witness.key)) {
      const record = await recordAt(witness.key);
      if (typeof record === "object") {
        if (record.base.attempt !== null) {
          evidence.add(record.base.attempt);
        }
      } else if (record === "unusable") {
        await retireRecord(witness.key);
      }
    }
    const verdict = steps.classify(
      members.map((record) => record.attempt),
      evidence,
      untrusted,
    );
    if (verdict.winner !== null) {
      const winner = members.find((record) => record.attempt === verdict.winner)!;
      const loser = members.find(
        (record) => record !== winner && verdict.losers.includes(record.attempt),
      );
      work.push({
        floor,
        winner: winner.tail,
        quarantined: false,
        due_at: null,
        next: 0,
        loser: loser === undefined ? null : { record: loser.tail, next: 0 },
      });
      resolvedThrough = floor;
      if (stuck?.floor === floor) {
        stuck = null;
      }
      continue;
    }
    if (verdict.ambiguous) {
      counter("ambiguous_floor_total");
    }
    if (stuck?.floor !== floor) {
      stuck = { floor, since: null };
    } else if (
      stuck.since !== null &&
      steps.isDue(addMinutes(new Date(stuck.since), TREE_GC_SWEEP_AGE_MINUTES), lastClock)
    ) {
      // Stuck long enough: retire the floor leak-only and move on.
      for (const record of members) {
        await retireRecord(record.key);
      }
      resolvedThrough = floor;
      stuck = null;
      continue;
    }
    break;
  }
  // Records of an untrusted identity are retired leak-only, named or not.
  for (const record of records) {
    if (untrusted.has(record.attempt)) {
      await retireRecord(record.key);
    }
  }

  // 7. The probe. Past the reset, every tick here probes.
  let etag = e0;
  let serverTime: Date | undefined;
  const probed: TreeGcState = {
    ...base,
    ticks: base.ticks + 1,
    probed_local_at: local.toISOString(),
  };
  try {
    const result = await putState(probed, e0);
    etag = result.etag;
    serverTime = steps.now(result.serverDate, local);
  } catch (error) {
    if (!isUnknownFate(error)) {
      throw error;
    }
    return end("conflict", { deleted, probed: true, candidates });
  }
  probeWon = true;
  for (const key of queuedRetirements) {
    await storage.delete(key, opts);
    deleted.push(key);
  }
  if (serverTime === undefined) {
    counter("no_server_time_total");
    warn(
      "tree_gc_no_server_time",
      { collection },
      `tree GC is not reclaiming replaced nodes of collection ${JSON.stringify(collection)}: storage reported no server time.`,
    );
  }
  const now = serverTime;
  if (serverTime !== undefined) {
    for (const [i, entry] of work.entries()) {
      if (entry.due_at === null) {
        work[i] = { ...entry, due_at: addMinutes(serverTime, TREE_GC_SUPERSEDED_DELAY_MINUTES) };
      }
    }
    if (stuck !== null && stuck.since === null) {
      stuck = { ...stuck, since: serverTime.toISOString() };
    }
  }

  // 8. Checks and DELETEs. The sweep page's notes are held back from the
  // candidate budget first, so a short ledger shortens the page instead.
  const noteBudget = Math.min(listed.length, candidates);
  let budget = candidates - noteBudget;
  let halted = false;
  const view = createTreeGcRootView(storage, prefix, root, config, signal);
  const rootChildAttempts = new Set(
    root?.node.kind === "branch" ? root.node.children.map((entry) => entry.attempt) : [],
  );
  const deleteNode = async (key: string): Promise<void> => {
    await storage.delete(key, opts);
    deleted.push(key);
  };
  /** Handle what a check found for `x`; false when the tick must stop deleting. */
  const settle = async (
    x: string,
    found: TreeGcMembership,
    role: "loser" | "superseded" | "sweep",
    attempt: string,
  ): Promise<boolean> => {
    switch (found) {
      case "path-unreadable": {
        counter("path_unreadable_total");
        halted = true;
        return false;
      }
      case "non-member": {
        await deleteNode(x);
        return true;
      }
      case "corrupt": {
        counter("corrupt_node_total");
        const guardHolds = attempt !== head.attempt && !rootChildAttempts.has(attempt);
        if (steps.onCorrupt(role, guardHolds)) {
          await deleteNode(x);
          warn(
            "tree_gc_corrupt_node",
            { collection, key: x, deleted: true },
            `tree GC deleted node ${x} of collection ${JSON.stringify(collection)}: its stored body did not match its key or did not parse. No current data used it.`,
          );
        } else {
          warn(
            "tree_gc_corrupt_node",
            { collection, key: x, deleted: false },
            `tree GC left node ${x} of collection ${JSON.stringify(collection)} in place: its stored body does not match its key or does not parse. If reads of this collection report InvalidResponse, export it with baerly admin dump and load the dump into a new collection.`,
          );
        }
        return true;
      }
      default: {
        return true;
      }
    }
  };

  // 8a. Losers' fresh nodes, at once.
  for (const [i, entry] of work.entries()) {
    if (halted || budget <= 0) {
      break;
    }
    if (entry.loser === null) {
      continue;
    }
    if (!deletable(entry.loser.record.slice(0, 32))) {
      work[i] = { ...entry, loser: null };
      continue;
    }
    const key = recordKeyOf(entry.floor, entry.loser.record);
    const record = retired.has(key) ? "absent" : await recordAt(key);
    if (record === "budget") {
      break;
    }
    if (record === "absent" || record === "unusable") {
      if (record === "absent" || (await retireRecord(key))) {
        work[i] = { ...entry, loser: null };
      }
      continue;
    }
    let next = entry.loser.next;
    while (next < record.fresh.length && budget > 0) {
      const x = `${nodePrefix}${record.attempt}/${record.fresh[next]}`;
      budget -= 1;
      if (!(await settle(x, await steps.isMember(x, view), "loser", record.attempt))) {
        break;
      }
      next += 1;
    }
    if (next >= record.fresh.length && (await retireRecord(key))) {
      work[i] = { ...entry, loser: null };
    } else {
      work[i] = { ...entry, loser: { record: entry.loser.record, next } };
    }
  }

  // 8b. Due winners' superseded nodes.
  const dropped = new Set<number>();
  for (const [i, entry] of work.entries()) {
    if (halted) {
      break;
    }
    const key = recordKeyOf(entry.floor, entry.winner);
    const listedHere = floors.get(entry.floor) ?? [];
    if (retired.has(key) || (pageCovers(entry.floor) && !listedHere.some((r) => r.key === key))) {
      // Its record is gone: the slot ends.
      dropped.add(i);
      continue;
    }
    if (entry.quarantined) {
      // Its identity was reused, so it is never a deletion source: once
      // its loser is done, its record is retired leak-only and the slot ends.
      if (work[i]!.loser === null && (await retireRecord(key))) {
        dropped.add(i);
      }
      continue;
    }
    if (!steps.isDue(entry.due_at, now) || budget <= 0) {
      continue;
    }
    const record = await recordAt(key);
    if (record === "budget") {
      break;
    }
    if (record === "absent" || record === "unusable") {
      if (record === "absent" || (await retireRecord(key))) {
        dropped.add(i);
      }
      continue;
    }
    let next = entry.next;
    while (next < record.superseded.length && budget > 0) {
      const ref = record.superseded[next]!;
      const x = `${nodePrefix}${ref}`;
      budget -= 1;
      if (!(await settle(x, await steps.isMember(x, view), "superseded", ref.slice(0, 32)))) {
        break;
      }
      next += 1;
    }
    work[i] = { ...entry, next };
    const othersListed = listedHere.some((r) => r.key !== key && !retired.has(r.key));
    if (
      next >= record.superseded.length &&
      work[i]!.loser === null &&
      !othersListed &&
      pageCovers(entry.floor) &&
      (await retireRecord(key))
    ) {
      // Retired before the slot is cleared by the state write.
      dropped.add(i);
    }
  }
  const remaining = work.filter((_, i) => !dropped.has(i));

  // 8c. Due sweep marks.
  let marks: TreeGcMark[] = [...base.sweep.marks];
  const keep: TreeGcMark[] = [];
  for (const mark of marks) {
    if (
      halted ||
      budget <= 0 ||
      mark.due_at === null ||
      !steps.isDue(mark.due_at, now) ||
      !deletable(mark.key.slice(0, 32))
    ) {
      keep.push(mark);
      continue;
    }
    const x = `${nodePrefix}${mark.key}`;
    budget -= 1;
    const found = await steps.sweepIsMember(x, view, "delete");
    if (found === "deferred") {
      keep.push(mark);
      continue;
    }
    if (!(await settle(x, found, "sweep", mark.key.slice(0, 32)))) {
      keep.push(mark);
    }
  }
  marks = keep;

  // 9. The sweep page: note new marks, stamp noted ones a later floor closed.
  let cursor = base.sweep.cursor;
  const marked = new Set(marks.map((mark) => mark.key));
  let notes = 0;
  /** How many listed keys this tick examined; the cursor moves past only those. */
  let examined = 0;
  for (const key of listed) {
    if (halted || notes >= noteBudget) {
      break;
    }
    examined += 1;
    const parts = steps.parsesKey(prefix, key);
    if (parts === null) {
      counter("unknown_key_total");
      continue;
    }
    const tail = key.slice(nodePrefix.length);
    if (marked.has(tail) || marks.length >= TREE_GC_MAX_SWEEP_MARKS || !deletable(parts.attempt)) {
      continue;
    }
    notes += 1;
    const found = await steps.sweepIsMember(key, view, "note");
    if (found === "corrupt") {
      // Counted and warned; a sweep candidate GC cannot authenticate stays.
      await settle(key, found, "sweep", parts.attempt);
    } else if (found === "path-unreadable") {
      counter("path_unreadable_total");
      halted = true;
    } else if (found === "non-member") {
      const stamp = steps.startsAge("note") && serverTime !== undefined;
      marks.push({
        key: tail,
        floor: h,
        due_at: stamp ? addMinutes(serverTime!, TREE_GC_SWEEP_AGE_MINUTES) : null,
      });
      marked.add(tail);
    }
  }
  const stamped: TreeGcMark[] = [];
  for (const mark of marks) {
    if (
      halted ||
      mark.due_at !== null ||
      serverTime === undefined ||
      !steps.startsAge("stamp") ||
      !steps.passesFloorGate(mark.floor, h) ||
      !deletable(mark.key.slice(0, 32)) ||
      budget <= 0
    ) {
      stamped.push(mark);
      continue;
    }
    budget -= 1;
    const found = await steps.sweepIsMember(`${nodePrefix}${mark.key}`, view, "stamp");
    if (found === "non-member") {
      stamped.push({ ...mark, due_at: addMinutes(serverTime, TREE_GC_SWEEP_AGE_MINUTES) });
    } else if (found === "path-unreadable") {
      counter("path_unreadable_total");
      halted = true;
      stamped.push(mark);
    } else if (found === "deferred") {
      stamped.push(mark);
    } else if (found === "corrupt") {
      await settle(`${nodePrefix}${mark.key}`, found, "sweep", mark.key.slice(0, 32));
    }
    // A member, a gone node or a corrupt one leaves the sweep's list.
  }
  marks = stamped;
  if (examined < listed.length) {
    cursor = examined === 0 ? cursor : listed[examined - 1]!;
  } else {
    cursor = listed.length < TREE_GC_SWEEP_LIST_KEYS ? null : listed.at(-1)!;
  }

  // 10. The state write, when the tick changed anything.
  const prior = probed;
  const final: TreeGcState = {
    ...prior,
    floor_seen: h,
    clock: serverTime !== undefined ? serverTime.toISOString() : prior.clock,
    resolved_through: resolvedThrough,
    stuck,
    work: remaining,
    sweep: { cursor, marks },
  };
  if (!sameState(final, prior)) {
    try {
      await putState({ ...final, ticks: prior.ticks + 1 }, etag);
    } catch (error) {
      if (!isUnknownFate(error)) {
        throw error;
      }
    }
  }

  // 11. Log retirement, as main's GC phase ends.
  await retire();
  return end("collected", { deleted, serverTime, probed: true, candidates });
};
