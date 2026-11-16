/**
 * Exhaustive fault scripts over the writer's commit path. The hand-picked
 * cases live in `writer-create-fate.test.ts`; this file enumerates them.
 *
 * The first suite scripts the committing create: each slot gets one `put`,
 * which takes the next event of the script. The second scripts every GET,
 * PUT, and DELETE a commit issues, for an insert and an update. Every
 * script must uphold the same contract:
 *
 * - a commit whose entry is durable never fails retriably (it returns, or
 *   throws `AmbiguousCommit`);
 * - a commit that returns is its own single durable entry, never a
 *   rival's;
 * - no mutation is ever written twice.
 */

import {
  BaerlyError,
  createCurrentJson,
  decodeJsonBytes,
  encodeJsonBytes,
  type LogEntry,
  MemoryStorage,
  type StorageGetOptions,
  type StorageGetResult,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { logStateCurrentJson } from "../../../tests/fixtures/log-state.ts";
import { createObservabilityContext, runWithContext } from "./observability/context.ts";
import { Writer } from "./writer.ts";

const PREFIX = "app/a/tenant/t/manifests/c";
const KEY = `${PREFIX}/current.json`;
const RIVAL_SESSION = "rival1";

/**
 * `pnpm test:randomize` sets `BAERLY_RANDOMIZE=1` and runs the
 * every-operation sweep at depth 7 (about 20 seconds). `pnpm test` runs
 * depth 5, which reaches only the early operations of a commit: an
 * uncontended insert's GET, GET, PUT, GET plus one more, and an update's
 * GET, GET, GET, PUT, GET. Faults on the forward-probe path after a rival
 * there are swept only under `test:randomize`. The create suite scripts the
 * forward probe's creates in both modes.
 */
const FULL_SWEEP = process.env["BAERLY_RANDOMIZE"] === "1";

/** All scripts of `depth` events over `events`, in lexicographic order. */
function* scripts<E>(events: readonly E[], depth: number): Generator<E[]> {
  if (depth === 0) {
    yield [];
    return;
  }
  for (const head of events) {
    for (const tail of scripts(events, depth - 1)) {
      yield [head, ...tail];
    }
  }
}

/** A foreign writer's entry for the slot `mine` targets. */
const rivalOf = (mine: LogEntry, samePayload: boolean): LogEntry => ({
  ...mine,
  session: RIVAL_SESSION,
  lsn: `${mine.lsn}-rival`,
  ...(!samePayload && { doc_id: "rival-doc", after: { _id: "rival-doc" } }),
});

const notAppliedError = (): BaerlyError =>
  new BaerlyError("NetworkError", "scripted throttle; no attempt applied", {
    cause: { status: 429, throttled: true, notApplied: true },
  });

// Write-tick maintenance is swallowed: the commit path is what's scripted.
const quietContext = () => createObservabilityContext({ maintenance: { dispatch: () => {} } });

/**
 * Committing-create events, one per slot:
 *
 * - `ok`: the create lands and is acknowledged;
 * - `lost-ack`: the create lands, then the call fails transiently;
 * - `fail`: the call fails transiently without landing;
 * - `not-applied`: the call reports `cause.notApplied` and did not land;
 * - `denied`: the call fails with a definitive `AccessDenied`;
 * - `rival-same` / `rival-different`: a foreign writer takes the slot
 *   first with an entry carrying the same or a different payload, so the
 *   create gets `412`;
 * - `rival-not-applied`: a foreign writer takes the slot first and the call
 *   reports `cause.notApplied` instead of `412`, as R2 can answer a lost
 *   same-key create race with a throttle.
 */
const CREATE_EVENTS = [
  "ok",
  "lost-ack",
  "fail",
  "not-applied",
  "denied",
  "rival-same",
  "rival-different",
  "rival-not-applied",
] as const;
type CreateEvent = (typeof CREATE_EVENTS)[number];

class ScriptedCreateStorage extends MemoryStorage {
  /** Committing-create keys, in send order. */
  readonly sends: string[] = [];
  /** The error each scripted failure threw, by send index. */
  readonly thrown = new Map<number, BaerlyError>();
  #script: readonly CreateEvent[] = [];

  arm(script: readonly CreateEvent[]): void {
    this.#script = script;
  }

  override async put(
    key: string,
    body: Uint8Array,
    opts?: StoragePutOptions,
  ): Promise<StoragePutResult> {
    if (!key.startsWith(`${PREFIX}/log/`) || opts?.ifNoneMatch !== "*") {
      return super.put(key, body, opts);
    }
    const index = this.sends.push(key) - 1;
    const event = this.#script[index] ?? "ok";
    const fail = (error: BaerlyError): never => {
      this.thrown.set(index, error);
      throw error;
    };
    switch (event) {
      case "ok": {
        return super.put(key, body, opts);
      }
      case "lost-ack": {
        await super.put(key, body, opts);
        return fail(new BaerlyError("NetworkError", "scripted lost acknowledgement"));
      }
      case "fail": {
        return fail(new BaerlyError("NetworkError", "scripted transient failure"));
      }
      case "not-applied": {
        return fail(notAppliedError());
      }
      case "denied": {
        return fail(new BaerlyError("AccessDenied", "scripted denial"));
      }
      case "rival-same":
      case "rival-different": {
        const rival = rivalOf(decodeJsonBytes<LogEntry>(body), event === "rival-same");
        await super.put(key, encodeJsonBytes(rival), { ifNoneMatch: "*" });
        return super.put(key, body, opts); // 412: the rival holds the slot
      }
      case "rival-not-applied": {
        const rival = rivalOf(decodeJsonBytes<LogEntry>(body), false);
        await super.put(key, encodeJsonBytes(rival), { ifNoneMatch: "*" });
        return fail(notAppliedError());
      }
    }
  }

  async logEntries(): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];
    for await (const { key } of this.list(`${PREFIX}/log/`)) {
      const got = await this.get(key);
      entries.push(decodeJsonBytes<LogEntry>(got!.body));
    }
    return entries;
  }
}

const runCreateScript = async (script: readonly CreateEvent[]) => {
  const storage = new ScriptedCreateStorage();
  await createCurrentJson(storage, KEY, logStateCurrentJson());
  storage.arm(script);
  const writer = new Writer({ storage, currentJsonKey: KEY });
  let outcome: { readonly entry: LogEntry } | { readonly error: unknown };
  try {
    const result = await runWithContext(quietContext(), () =>
      writer.commit({ op: "I", collection: "c", docId: "mine", body: { _id: "mine" } }),
    );
    outcome = { entry: result.entry };
  } catch (error) {
    outcome = { error };
  }
  const entries = await storage.logEntries();
  const own = entries.filter((entry) => entry.session !== RIVAL_SESSION);
  return { outcome, own, storage };
};

describe("writer committing-create fault scripts", () => {
  test("every depth-4 script resolves exactly once, with one create per slot", async () => {
    const violations: string[] = [];
    let count = 0;
    for (const script of scripts(CREATE_EVENTS, 4)) {
      count++;
      const { outcome, own, storage } = await runCreateScript(script);
      const label = script.join(",");
      if (own.length > 1) {
        violations.push(`${label}: duplicated (${own.length} own entries)`);
      }
      if (new Set(storage.sends).size !== storage.sends.length) {
        violations.push(`${label}: resent a slot (${storage.sends.join(" ")})`);
      }
      // Only a rival moves the commit to a new slot, so the slot of the
      // first non-rival event decides the outcome. A rival hidden behind a
      // throttle must forward-probe too, not surface the throttle as final.
      const last = storage.sends.length - 1;
      const decisive = script[last] ?? "ok";
      if (decisive.startsWith("rival")) {
        violations.push(`${label}: stopped at a rival-held slot ${last}`);
        continue;
      }
      if ("entry" in outcome) {
        if (outcome.entry.session === RIVAL_SESSION) {
          violations.push(`${label}: adopted a rival`);
        }
        if (own.length !== 1 || own[0]!.seq !== outcome.entry.seq) {
          violations.push(`${label}: returned seq ${outcome.entry.seq} is not its own entry`);
        }
        if (outcome.entry.seq !== last) {
          violations.push(`${label}: committed at seq ${outcome.entry.seq}, not ${last}`);
        }
        if (decisive !== "ok" && decisive !== "lost-ack") {
          violations.push(`${label}: returned after a ${decisive} create`);
        }
        continue;
      }
      const error = outcome.error;
      if (!(error instanceof BaerlyError)) {
        violations.push(`${label}: threw a non-BaerlyError ${String(error)}`);
        continue;
      }
      if (own.length === 1 && (error.retriable || error.code !== "AmbiguousCommit")) {
        violations.push(`${label}: durable but failed with ${error.code}`);
      }
      switch (decisive) {
        case "ok":
        case "lost-ack": {
          violations.push(`${label}: failed with ${error.code} after a landed create`);
          break;
        }
        case "fail": {
          // An empty slot cannot prove the send will never land.
          if (error.code !== "AmbiguousCommit" || error.retriable) {
            violations.push(`${label}: uncertain create failed with ${error.code}`);
          }
          break;
        }
        case "not-applied":
        case "denied": {
          // Provably unapplied: the adapter's own error stands as-is.
          if (error !== storage.thrown.get(last)) {
            violations.push(`${label}: ${decisive} create surfaced ${error.code}`);
          }
          break;
        }
      }
    }
    expect(count).toBe(CREATE_EVENTS.length ** 4);
    expect(violations).toEqual([]);
  });
});

/**
 * Events for every storage operation of a commit:
 *
 * - `ok`: the operation succeeds;
 * - `fail`: a transient failure without effect;
 * - `lost`: the operation takes effect, then fails transiently;
 * - `not-applied`: a `cause.notApplied` failure without effect;
 * - `denied`: a definitive `AccessDenied` without effect;
 * - `rival`: before a log create, a foreign writer takes the slot; on any
 *   other operation, `ok`;
 * - `rival-not-applied`: on a log create, a foreign writer takes the slot
 *   and the call reports `cause.notApplied`; on any other operation,
 *   `not-applied`.
 */
const OP_EVENTS = [
  "ok",
  "fail",
  "lost",
  "not-applied",
  "denied",
  "rival",
  "rival-not-applied",
] as const;
type OpEvent = (typeof OP_EVENTS)[number];

class EveryOpStorage extends MemoryStorage {
  /**
   * Throttles that hid a rival's slot where the script lets the next
   * operation, the occupant readback, succeed: the readback shows the
   * rival, so the writer must forward-probe rather than surface the
   * throttle.
   */
  readonly resolvableThrottles = new Set<BaerlyError>();
  #script: readonly OpEvent[] = [];
  #index = 0;
  #armed = false;

  arm(script: readonly OpEvent[]): void {
    this.#script = script;
    this.#index = 0;
    this.#armed = true;
  }

  #before(op: string): OpEvent {
    const event = this.#armed ? (this.#script[this.#index++] ?? "ok") : "ok";
    switch (event) {
      case "fail": {
        throw new BaerlyError("NetworkError", `scripted ${op} failure`);
      }
      case "not-applied": {
        throw notAppliedError();
      }
      case "rival-not-applied": {
        if (op !== "PUT") {
          throw notAppliedError();
        }
        return event;
      }
      case "denied": {
        throw new BaerlyError("AccessDenied", `scripted ${op} denial`);
      }
      default: {
        return event;
      }
    }
  }

  override async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
    const event = this.#before("GET");
    const got = await super.get(key, opts);
    if (event === "lost") {
      throw new BaerlyError("NetworkError", "scripted GET lost response");
    }
    return got;
  }

  override async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
    const event = this.#before("DELETE");
    await super.delete(key, opts);
    if (event === "lost") {
      throw new BaerlyError("NetworkError", "scripted DELETE lost response");
    }
  }

  override async put(
    key: string,
    body: Uint8Array,
    opts?: StoragePutOptions,
  ): Promise<StoragePutResult> {
    const event = this.#before("PUT");
    const isLogCreate = key.startsWith(`${PREFIX}/log/`) && opts?.ifNoneMatch === "*";
    if ((event === "rival" || event === "rival-not-applied") && isLogCreate) {
      const rival = rivalOf(decodeJsonBytes<LogEntry>(body), false);
      await super.put(key, encodeJsonBytes(rival), { ifNoneMatch: "*" }).catch(() => undefined);
    }
    if (event === "rival-not-applied") {
      const error = notAppliedError();
      const readback = this.#script[this.#index] ?? "ok";
      if (isLogCreate && (readback === "ok" || readback === "rival")) {
        this.resolvableThrottles.add(error);
      }
      throw error;
    }
    const result = await super.put(key, body, opts);
    if (event === "lost") {
      throw new BaerlyError("NetworkError", "scripted PUT lost response");
    }
    return result;
  }

  /** The log entries carrying the scripted mutation's marker. */
  async marked(): Promise<LogEntry[]> {
    this.#armed = false;
    const entries: LogEntry[] = [];
    for await (const { key } of this.list(`${PREFIX}/log/`)) {
      const got = await super.get(key);
      const entry = decodeJsonBytes<LogEntry>(got!.body);
      if ((entry.after as { marker?: string } | undefined)?.marker === "M") {
        entries.push(entry);
      }
    }
    return entries;
  }
}

const OP_DEPTH = FULL_SWEEP ? 7 : 5;

describe("writer fault scripts over every storage operation", () => {
  test.each(["I", "U"] as const)(
    `op=%s: exactly-once across every depth-${OP_DEPTH} script`,
    { timeout: FULL_SWEEP ? 600_000 : 20_000 },
    async (op) => {
      const violations: string[] = [];
      for (const script of scripts(OP_EVENTS, OP_DEPTH)) {
        const storage = new EveryOpStorage();
        await createCurrentJson(storage, KEY, logStateCurrentJson());
        if (op === "U") {
          await runWithContext(quietContext(), () =>
            new Writer({ storage, currentJsonKey: KEY }).commit({
              op: "I",
              collection: "c",
              docId: "mine",
              body: { _id: "mine", f: 0 },
            }),
          );
        }
        storage.arm(script);
        const writer = new Writer({ storage, currentJsonKey: KEY });
        let failure: unknown;
        let returned: LogEntry | undefined;
        try {
          const result = await runWithContext(quietContext(), () =>
            writer.commit({
              op,
              collection: "c",
              docId: "mine",
              body: { _id: "mine", f: 1, marker: "M" },
            }),
          );
          returned = result.entry;
        } catch (error) {
          failure = error;
        }
        const marked = await storage.marked();
        const label = script.join(",");
        if (marked.length > 1) {
          violations.push(`${label}: duplicated`);
        } else if (returned !== undefined) {
          if (returned.session === RIVAL_SESSION) {
            violations.push(`${label}: adopted a rival`);
          } else if (marked.length !== 1 || marked[0]!.seq !== returned.seq) {
            violations.push(`${label}: returned seq ${returned.seq} is not its durable entry`);
          }
        } else if (!(failure instanceof BaerlyError)) {
          violations.push(`${label}: threw a non-BaerlyError ${String(failure)}`);
        } else if (marked.length === 1 && failure.code !== "AmbiguousCommit") {
          violations.push(`${label}: durable but failed with ${failure.code}`);
        } else if (failure.code === "AmbiguousCommit" && failure.retriable) {
          violations.push(`${label}: AmbiguousCommit marked retriable`);
        } else if (storage.resolvableThrottles.has(failure)) {
          violations.push(`${label}: surfaced a throttle that hid a rival's slot`);
        }
      }
      expect(violations).toEqual([]);
    },
  );
});
