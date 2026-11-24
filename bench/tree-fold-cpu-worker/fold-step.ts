/**
 * The measured operation: one tree fold tick (`foldTree`: prepare, then
 * publish) under a fresh Workers Paid request ledger. Runtime-agnostic, so
 * the Worker and the Node baseline run the identical call.
 *
 * The tick passes the writer's committed tail as `knownTail`, as the write
 * tick would. A capped cell cuts the log at `cap` entries: every
 * `log/<seq>` GET at or past `floor + cap` is sent for a key that does not
 * exist, so the fold reads the cut, probes one missing slot and stops at the
 * tail, with the same storage calls as a log that really ends there.
 */
import {
  logObjectKey,
  MemoryStorage,
  RequestLedger,
  retryStorageCall,
  type Storage,
} from "@baerly/protocol";
import {
  createObservabilityContext,
  runWithContext,
} from "../../packages/server/src/observability/context.ts";
import { foldTree } from "../../packages/server/src/tree/fold.ts";
import { type Cell, collectionPrefix, LEDGER_CALLS, TAIL_ENTRIES } from "./cells.ts";

/** A seq no fixture reaches; its log key never exists. */
const ABSENT_SEQ = 999_999_999;

/** `inner` with the log of `prefix` ending at `end`. */
export const cutLog = (inner: Storage, prefix: string, end: number): Storage => {
  const logPrefix = logObjectKey(prefix, 0).slice(0, -"0.json".length);
  const absent = logObjectKey(prefix, ABSENT_SEQ);
  const visible = (key: string): string => {
    if (!key.startsWith(logPrefix) || !key.endsWith(".json")) {
      return key;
    }
    const seq = Number(key.slice(logPrefix.length, -".json".length));
    return Number.isInteger(seq) && seq >= end ? absent : key;
  };
  return {
    get: (key, opts) => inner.get(visible(key), opts),
    put: (key, body, opts) => inner.put(key, body, opts),
    delete: (key, opts) => inner.delete(key, opts),
    list: (listPrefix, opts) => inner.list(listPrefix, opts),
  };
};

/**
 * `inner` behind `retryStorageCall` on the internal pool, as the R2 binding
 * adapter wraps each call, so the ledger charges memory-backed calls the way
 * it charges R2 ones.
 */
export const retrying = (inner: Storage): Storage => {
  const pool = "internal" as const;
  return {
    get: (key, opts) => retryStorageCall(() => inner.get(key, opts), { pool }),
    put: (key, body, opts) =>
      retryStorageCall(() => inner.put(key, body, opts), {
        pool,
        conditionalCreate: opts?.ifNoneMatch === "*",
        compareAndSwap: opts?.ifMatch !== undefined,
      }),
    delete: (key, opts) => retryStorageCall(() => inner.delete(key, opts), { pool }),
    list: (prefix, opts) => inner.list(prefix, opts),
  };
};

/** A fresh in-memory bucket holding `objects`, behind the adapter retry. */
export const memoryStorageOf = async (
  objects: ReadonlyMap<string, Uint8Array>,
): Promise<Storage> => {
  const storage = new MemoryStorage();
  for (const [key, bytes] of objects) {
    await storage.put(key, bytes);
  }
  return retrying(storage);
};

/** What one tick did. */
export interface FoldStepResult {
  /** The fold outcome: `published`, `cas-lost`, `refused` or `nothing-to-fold`. */
  readonly outcome: string;
  readonly floor: number;
  readonly foldEnd: number;
  /** Entries folded: `foldEnd - floor`. */
  readonly folded: number;
  /** Why the fold ended before the tail (`budget`, ...), or `null` at the tail. */
  readonly stop: string | null;
  readonly stopSeq: number | null;
  /** Fresh nodes the publication wrote, the root included. */
  readonly nodesWritten: number;
  /** Requests the ledger charged (every attempt). */
  readonly ledgerCharged: number;
  /** In-isolate wall time of the tick. On workerd it advances only across I/O. */
  readonly ms: number;
}

/**
 * One fold tick of `cell` on `storage` (the fixture, behind the adapter
 * retry), under a fresh {@link LEDGER_CALLS}-call ledger.
 */
export const runFoldStep = async (storage: Storage, cell: Cell): Promise<FoldStepResult> => {
  const prefix = collectionPrefix(cell.fixture.tenant);
  const end = cell.cap ?? TAIL_ENTRIES;
  const ledger = new RequestLedger({ internal: LEDGER_CALLS, external: LEDGER_CALLS });
  const t0 = performance.now();
  const outcome = await runWithContext(createObservabilityContext({ ledger }), () =>
    foldTree({
      storage: cell.cap === null ? storage : cutLog(storage, prefix, end),
      prefix,
      knownTail: end,
    }),
  );
  const ms = performance.now() - t0;
  const stop = outcome.kind === "nothing-to-fold" ? undefined : outcome.stop;
  const published = outcome.kind === "published" || outcome.kind === "cas-lost";
  return {
    outcome: outcome.kind,
    floor: outcome.floor,
    foldEnd: published ? outcome.foldEnd : outcome.floor,
    folded: published ? outcome.foldEnd - outcome.floor : 0,
    stop: stop?.reason ?? null,
    stopSeq: stop?.seq ?? null,
    nodesWritten: published ? outcome.publication.written : 0,
    ledgerCharged: ledger.charged.internal,
    ms,
  };
};

/**
 * Why `result` is not a valid sample of `cell`, or `null`: the tick must
 * publish, a capped cell must fold exactly `cap` entries, and a whole-log
 * cell must end on the budget.
 */
export const sampleProblem = (cell: Cell, result: FoldStepResult): string | null => {
  if (result.outcome !== "published") {
    return `outcome ${result.outcome}${result.stop === null ? "" : ` (${result.stop})`}`;
  }
  if (cell.cap !== null && (result.folded !== cell.cap || result.stop !== null)) {
    return `folded ${result.folded} of the ${cell.cap}-entry cut (stop ${result.stop})`;
  }
  if (cell.cap === null && result.stop !== "budget") {
    return `whole-log tick ended for ${result.stop ?? "the tail"}, not the budget`;
  }
  return null;
};
