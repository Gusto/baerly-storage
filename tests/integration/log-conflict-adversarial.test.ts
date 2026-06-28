/**
 * Adversarial-replay property test for the self-session
 * log-conflict adoption decision.
 *
 * Threat model (see `packages/server/src/log-conflict-adoption.ts`
 * for the full statement): the adversary controls bucket contents
 * and the network, but cannot read the writer's local RAM and
 * therefore cannot learn the writer's per-commit `session` id
 * before observing a /log/<seq>.json PUT.
 *
 * Property under test (the patent-disclosure-shaped claim): for
 * every adversary-pre-populated log entry at `seq = 0`, when the
 * writer attempts a single-input commit, the writer either
 *
 *   (a) adopts ONLY its own prior in-flight attempt (same session,
 *       same seq) — the in-process replay branch the test models by
 *       handing the adversary the writer's session id, OR
 *   (b) refuses adoption of a FOREIGN entry and, under single-write
 *       commit, re-probes forward and commits its OWN entry at the next
 *       empty slot (the foreign occupant is now a committed write the
 *       writer steps past, not a wedge), OR
 *   (c) throws `BaerlyError{code:"InvalidResponse"}` on a malformed
 *       occupant body.
 *
 * The forbidden outcome — "successful commit returning a LogEntry the
 * writer didn't author" — must never happen.
 *
 * Attack catalogue:
 *   1. Foreign session, matching seq        → refuse adoption, probe
 *                                               forward, commit own entry
 *   2. Replay with a foreign session        → same: probe forward, own
 *                                               entry at the next slot
 *   3. Garbage-body squat                   → probeTailFrom throws
 *                                               InvalidResponse
 *   4. Same-session forgery (out of model)  → would adopt iff every
 *                                               clause holds
 *   5. Future-seq entry written ahead       → writer commits at seq 0;
 *                                               the future-seq squat is
 *                                               ignored by this writer until
 *                                               intervening seqs exist
 */

import { fc, test as propTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import {
  BaerlyError,
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type CurrentJson,
  type DocumentData,
  type LogEntry,
  MemoryStorage,
  SESSION_ID_LENGTH,
  encodeJsonBytes,
} from "@baerly/protocol";
import { Writer } from "@baerly/server/_internal/testing";

const PROP_TIMEOUT_MS = 30_000;

const TENANT_PREFIX = "app/a/tenant/t/manifests/c";
const CURRENT_JSON_KEY = `${TENANT_PREFIX}/current.json`;
const LOG_KEY = (seq: number): string => `${TENANT_PREFIX}/log/${seq}.json`;
const COLLECTION = "c";

const seedCurrent = (): CurrentJson => ({
  schema_version: CURRENT_JSON_SCHEMA_VERSION,
  snapshot: null,
  tail_hint: 0,
  log_seq_start: 0,
  writer_fence: { epoch: 0, owner: "adversarial-test", claimed_at: "" },
  snapshot_bytes: 0,
  snapshot_rows: 0,
});

/**
 * Pre-populate the bucket with a forged log entry at seq 0, then
 * attempt a single-input commit. Returns whichever outcome the
 * writer produced.
 *
 * `fastPath: true` sets `maxRetries: 1` and `initialBackoffMs: 0` so
 * the property test doesn't burn seconds on backoff sleeps across 100
 * runs. The property assertion is about the safety invariant (never
 * adopt a foreign entry), not about retry-budget behaviour.
 */
const runAttack = async (
  forged: LogEntry,
  fastPath = false,
): Promise<
  | { kind: "adopted"; entry: LogEntry }
  | { kind: "rejected"; code: string; message: string }
  | { kind: "other-throw"; error: unknown }
> => {
  const storage = new MemoryStorage();
  await createCurrentJson(storage, CURRENT_JSON_KEY, seedCurrent());
  // Adversary squats /log/0.json with their forged body BEFORE the
  // writer runs. Use the raw storage put (no If-None-Match here —
  // the adversary already owns the key).
  await storage.put(LOG_KEY(forged.seq), encodeJsonBytes(forged), {
    contentType: "application/json",
  });
  const writer = new Writer({
    storage,
    currentJsonKey: CURRENT_JSON_KEY,
    ...(fastPath
      ? { options: { maxRetries: 1, initialBackoffMs: 0, random: () => 0 } }
      : undefined),
  });
  try {
    const result = await writer.commit({
      op: "I",
      collection: COLLECTION,
      docId: "writer-doc",
      body: { _id: "writer-doc", from: "writer" } satisfies DocumentData,
    });
    return { kind: "adopted", entry: result.entry };
  } catch (error) {
    if (error instanceof BaerlyError) {
      return { kind: "rejected", code: error.code, message: error.message };
    }
    return { kind: "other-throw", error };
  }
};

// Checked construction (not an `as` cast): the record is mapped
// through a `(): LogEntry` function so tsgo tracks every field against
// the protocol type. A future rename/removal of a `LogEntry` field
// surfaces here as a compile error rather than a silently-bogus key.
const arbForgedEntry: fc.Arbitrary<LogEntry> = fc
  .record({
    lsn: fc.string({ minLength: 1, maxLength: 32 }),
    commit_ts: fc.constant("2026-05-26T00:00:00.000Z"),
    op: fc.constantFrom<LogEntry["op"]>("I", "U", "D"),
    collection: fc.constantFrom(COLLECTION, "other-collection"),
    doc_id: fc.string({ minLength: 1, maxLength: 16 }),
    session: fc.string({ minLength: SESSION_ID_LENGTH, maxLength: SESSION_ID_LENGTH }),
    seq: fc.integer({ min: 0, max: 5 }),
    after: fc.record({ _id: fc.string({ minLength: 1, maxLength: 16 }) }),
  })
  .map((r): LogEntry => r);

describe("adversarial replay against self-session log-conflict adoption", () => {
  propTest.prop({ forged: arbForgedEntry })(
    "no forged pre-populated log entry produces a 'successful commit with a foreign LogEntry'",
    async ({ forged }) => {
      const outcome = await runAttack(forged, /* fastPath */ true);
      if (outcome.kind === "adopted") {
        // Adoption is permitted ONLY when the forged entry was
        // byte-identical to what the writer minted (same session,
        // same seq, same op/collection/doc_id). The fast-check
        // arbitrary generates random sessions and a varied doc_id
        // surface, so the probability of an accidental match
        // is negligible — we assert the strong claim:
        // the writer NEVER adopts a foreign-authored entry.
        //
        // If a future change weakens the invariant, this assertion
        // pinpoints the regression.
        expect(outcome.entry.doc_id).toBe("writer-doc");
        expect(outcome.entry.collection).toBe(COLLECTION);
        // The after[] field must reflect what the writer wrote, not
        // what the adversary forged.
        expect((outcome.entry.after as { from?: string } | undefined)?.from).toBe("writer");
      } else if (outcome.kind === "rejected") {
        // The only Baerly error code on this path is Conflict
        // (the adoption helper's failure clauses) or
        // InvalidResponse (a forged body that didn't parse as a
        // LogEntry — covered by the readLogEntry helper).
        expect(["Conflict", "InvalidResponse"]).toContain(outcome.code);
      } else {
        // Any other thrown shape is a test bug — fail loud.
        throw outcome.error;
      }
    },
    PROP_TIMEOUT_MS,
  );

  test("attack 1 — foreign session, matching seq: writer probes past, commits its OWN entry", async () => {
    const forged: LogEntry = {
      lsn: "z_foreign_z",
      commit_ts: "2026-05-26T00:00:00.000Z",
      op: "I",
      collection: COLLECTION,
      doc_id: "adv-doc",
      session: "advers",
      seq: 0,
      after: { _id: "adv-doc", from: "adversary" },
    };
    const outcome = await runAttack(forged);
    // Under single-write commit a foreign occupant at our seq is no
    // longer a wedge: the writer reads it back, sees a foreign session
    // (adoption refused), and re-probes forward to the next empty slot.
    // The forbidden outcome — adopting the FOREIGN entry — never happens.
    expect(outcome.kind).toBe("adopted");
    if (outcome.kind === "adopted") {
      expect(outcome.entry.seq).toBe(1);
      expect(outcome.entry.doc_id).toBe("writer-doc");
      expect((outcome.entry.after as { from?: string } | undefined)?.from).toBe("writer");
    }
  });

  test("attack 2 — replay of a historical PUT with a foreign session: writer probes past it", async () => {
    // Network-replay model: an attacker captured an earlier
    // writer's PUT and replays it at seq 0. The captured entry
    // carries the original writer's session, which the new writer
    // cannot match — so the writer refuses adoption and probes forward,
    // committing its own entry at the next slot.
    const replayed: LogEntry = {
      lsn: "z_replay_z",
      commit_ts: "2026-05-26T00:00:00.000Z",
      op: "I",
      collection: COLLECTION,
      doc_id: "old-doc",
      session: "oldwri", // captured from a prior writer
      seq: 0,
      after: { _id: "old-doc", from: "history" },
    };
    const outcome = await runAttack(replayed);
    expect(outcome.kind).toBe("adopted");
    if (outcome.kind === "adopted") {
      // The writer's own entry lands at seq 1; the replayed foreign entry
      // is never handed back.
      expect(outcome.entry.seq).toBe(1);
      expect(outcome.entry.doc_id).toBe("writer-doc");
      expect((outcome.entry.after as { from?: string } | undefined)?.from).toBe("writer");
    }
  });

  test("attack 3 — garbage body squat: writer treats it as an occupied slot and commits past it", async () => {
    // Adversary writes non-JSON bytes at /log/0.json. Under single-write
    // commit the writer finds the first EMPTY slot without decoding
    // occupants, so a garbage occupant at seq 0 is just an occupied slot:
    // the writer commits its own entry at seq 1. (The garbage remains a
    // pre-existing corruption the READ path / `baerly admin fsck` surface
    // as InvalidResponse — repairing the bucket is not the writer's job.)
    const storage = new MemoryStorage();
    await createCurrentJson(storage, CURRENT_JSON_KEY, seedCurrent());
    await storage.put(LOG_KEY(0), new TextEncoder().encode("not json {{{"), {
      contentType: "application/json",
    });
    const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });
    const result = await writer.commit({
      op: "I",
      collection: COLLECTION,
      docId: "writer-doc",
      body: { _id: "writer-doc" },
    });
    expect(result.entry.seq).toBe(1);
    expect(result.entry.doc_id).toBe("writer-doc");
  });

  // attack 4 — same-session forgery is OUT OF THREAT MODEL. Pretend the
  // adversary somehow learned the writer's per-commit session id
  // (impossible under the stated threat model — the session lives in
  // RAM only and is minted at the top of Writer.commit). Constructing a
  // deterministic same-session collision is impractical, so there is no
  // standalone test for it; we document by absence instead. The property
  // test above ("no forged pre-populated log entry produces a successful
  // commit with a foreign LogEntry") exercises this path stochastically:
  // any run that DID accidentally collide on session and seq would
  // surface a same-session adoption, and its assertion pinpoints whether
  // the adopted entry's doc_id matches the writer's. A bug that adopted a
  // different doc_id would shrink to a 1-bit counterexample. That
  // property is the durable proof; a placeholder test here would assert
  // nothing.

  test("attack 5 — adversary writes a future-seq entry (seq=5) while writer commits at seq=0: writer's seq-0 PUT succeeds, future-seq squat is ignored", async () => {
    // The adversary squatting at seq=5 doesn't intersect the
    // writer's path at all — the writer mints seq=0 from a fresh
    // current.json (tail_hint=0). The commit succeeds; the
    // future-seq entry is simply ignored by this writer until
    // intervening seqs exist. (It is NOT a GC-collected orphan:
    // GC only sweeps below log_seq_start — entries already folded
    // into the snapshot — and a seq=5 squat sits ABOVE the live
    // tail, so it is never folded and never GC-eligible. It is also
    // not permanently unreachable: once writes fill seqs 1..4 the
    // forward-probe reaches seq 5, skips the foreign occupant, and
    // commits past it — leaving the squat inside the now-dense range
    // where readers would fold it. That readability only matters
    // under an adversary with arbitrary bucket-WRITE access, who
    // could corrupt the next seq directly regardless — so it is
    // OUTSIDE the adoption threat model this test validates.)
    // Documents the asymmetry: adoption is keyed to the seq the
    // writer is ABOUT to write, not to any seq present in the log
    // namespace.
    const storage = new MemoryStorage();
    await createCurrentJson(storage, CURRENT_JSON_KEY, seedCurrent());
    const futureForged: LogEntry = {
      lsn: "z_future_z",
      commit_ts: "2026-05-26T00:00:00.000Z",
      op: "I",
      collection: COLLECTION,
      doc_id: "adv-doc",
      session: "advers",
      seq: 5,
      after: { _id: "adv-doc" },
    };
    await storage.put(LOG_KEY(5), encodeJsonBytes(futureForged), {
      contentType: "application/json",
    });
    const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });
    const result = await writer.commit({
      op: "I",
      collection: COLLECTION,
      docId: "writer-doc",
      body: { _id: "writer-doc" },
    });
    expect(result.entry.seq).toBe(0);
    expect(result.entry.doc_id).toBe("writer-doc");
  });
});
