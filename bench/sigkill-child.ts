/**
 * S3-sigkill child entrypoint. Issues the synthetic three-step write
 * (PUT content → PUT log entry → CAS current.json) and prints a
 * `READY-N` line to stdout after each step. The parent watches stdout
 * and delivers SIGKILL after `READY-N` where N == BENCH_KILL_AFTER_STEP.
 *
 * Reads env: BENCH_VIA, BENCH_BUCKET, BENCH_TRIAL_BODY,
 * BENCH_TRIAL_SEQ, BENCH_KILL_AFTER_STEP. Exits 0 if it manages to
 * complete all three steps (uninteresting trial; the parent records
 * `orphan: false`). The interesting code path is being SIGKILL'd —
 * the child never returns from that point.
 */

import {
  BaerlyError,
  casUpdateCurrentJson,
  countKey,
  createCurrentJson,
  type CurrentJson,
  encodeJsonBytes,
  type LogEntry,
  logObjectKey,
  timestamp,
} from "@baerly/protocol";
import { buildBenchStorage, ensureBucket } from "./storage.ts";

const via = (process.env["BENCH_VIA"] as "direct" | "toxiproxy") ?? "direct";
const bucket = process.env["BENCH_BUCKET"] ?? "baerly-bench";
const seq = Number(process.env["BENCH_TRIAL_SEQ"] ?? "0");
const body = process.env["BENCH_TRIAL_BODY"] ?? "{}";

const SIGKILL_LOG_PREFIX = "bench/tenant-A/collection-sigkill";
const SIGKILL_CURRENT_KEY = `${SIGKILL_LOG_PREFIX}/current.json`;

const SEED: CurrentJson = {
  schema_version: 3,
  snapshot: null,
  tail_hint: seq,
  log_seq_start: 0,
  writer_fence: { epoch: 0, owner: "bench-sigkill", claimed_at: "" },
  snapshot_bytes: 0,
  snapshot_rows: 0,
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy via fresh ArrayBuffer: tsgo narrows `Uint8Array` to
  // `Uint8Array<ArrayBufferLike>`, which `crypto.subtle.digest` rejects
  // (wants `ArrayBufferView<ArrayBuffer>`). See microsoft/TypeScript#61375.
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function main(): Promise<void> {
  const storage = buildBenchStorage({ via, bucket });
  await ensureBucket({ via, bucket });
  // Re-create current.json. Conflict is fine — the parent reset it
  // between trials but a stale value from an earlier crash is also OK
  // (we'll CAS over it in step 3).
  try {
    await createCurrentJson(storage, SIGKILL_CURRENT_KEY, SEED);
  } catch (error) {
    if (!(error instanceof BaerlyError && error.code === "Conflict")) {
      throw error;
    }
  }

  const bodyBytes = new TextEncoder().encode(body);
  const hash = await sha256Hex(bodyBytes);

  // ── Step 1. PUT content. ────────────────────────────────────────
  const contentKey = `${SIGKILL_LOG_PREFIX}/content/${hash}.json`;
  await storage
    .put(contentKey, bodyBytes, {
      ifNoneMatch: "*",
      contentType: "application/json",
    })
    .catch((error: unknown) => {
      // ifNoneMatch:"*" returns Conflict on idempotent re-write; ignore.
      if (error instanceof BaerlyError && error.code === "Conflict") {
        return;
      }
      throw error;
    });
  process.stdout.write("READY-1\n");

  // ── Step 2. PUT log entry. ──────────────────────────────────────
  const logKey = logObjectKey(SIGKILL_LOG_PREFIX, seq);
  const session = "bench-sigkill";
  const logEntry: LogEntry = {
    lsn: `${timestamp(Date.now())}_${session}_${countKey(seq)}`,
    commit_ts: new Date().toISOString(),
    seq,
    collection: "sigkill",
    doc_id: `doc-${seq}`,
    op: "I",
    session,
    after: JSON.parse(body),
  };
  const logBytes = encodeJsonBytes(logEntry);
  await storage.put(logKey, logBytes, {
    ifNoneMatch: "*",
    contentType: "application/json",
  });
  process.stdout.write("READY-2\n");

  // ── Step 3. CAS current.json. ───────────────────────────────────
  await casUpdateCurrentJson(storage, SIGKILL_CURRENT_KEY, (cur) => ({
    ...cur,
    tail_hint: cur.tail_hint + 1,
  }));
  process.stdout.write("READY-3\n");
}

await main();
process.exit(0);
