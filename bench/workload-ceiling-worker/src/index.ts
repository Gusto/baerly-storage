/**
 * Deployed evidence Worker for the workload-ceiling study (parent plan
 * Task 8). This module is measurement-only: it is not part of any published
 * `@gusto/baerly-storage` entry point, it does not run in a user's
 * application, and importing it changes no production behavior.
 *
 * What it does, exactly:
 *
 *  1. Accepts one authenticated `POST /run` carrying a
 *     `WorkloadCeilingRunRequest` (`../../measurement/workload-ceiling-harness.ts`).
 *  2. Opens the EXACT fixture `workload-ceiling-provision.ts` already wrote
 *     under `fixture_prefix` — it never provisions one itself.
 *  3. Awaits ONE controlled fold subject —
 *     `foldChunkedSnapshotReference(rows, [])`, the same independent logical
 *     oracle `packages/server/src/chunked-snapshot-reference.test.ts` checks
 *     the chunk-native view against — over whichever representation
 *     `implementation` selects.
 *  4. Emits the run's join identifiers exactly once, as a single structured
 *     Workers Logs line, and returns the kernel result.
 *
 * What it deliberately does NOT do: provision fixtures, aggregate results
 * across runs, loop or retry, schedule cron, or self-report CPU time. CPU
 * time is never computed in this module — `Date.now()` / `performance.now()`
 * do not appear here. The only source of truth for CPU is the platform's own
 * `workersInvocationsAdaptive` telemetry, retrieved out-of-band by
 * `../../measurement/workload-ceiling-collect.ts`. See README.md for the
 * platform documentation this rests on.
 *
 * The three `implementation` values read the SAME logical row set through
 * different storage shapes and read paths, all written side by side under one
 * `fixture_prefix` by `workload-ceiling-provision.ts`:
 *
 *  - `monolithic-control` — today's shipped single-snapshot format at
 *    `fixture.json`'s `monolithic_key`, read through the shipped
 *    `loadSnapshotAsMap`, SHA-256 verification included, so what the study
 *    measures is what a caller would run.
 *  - `monolithic-control-unhashed` — the identical bytes at the identical
 *    key, differing by exactly one operation: the digest verification.
 *    A Worker may not time itself, so the cost of that verification has to
 *    be a difference of two platform-reported CPU numbers. It is a
 *    measurement-only probe, not a subject — see
 *    `WORKLOAD_CEILING_IMPLEMENTATIONS` where the arm is declared.
 *  - `chunked-candidate` — the proposed manifest + chunk layout, read
 *    through `openSnapshotView` (`packages/server/src/snapshot-view.ts`).
 *
 * All three feed the identical fold subject, so a comparison isolates the
 * storage-shape cost, not a difference in what gets computed.
 */
import type { DocumentData, Storage } from "@baerly/protocol";
import { r2BindingStorage } from "@baerly/adapter-cloudflare";
import { loadSnapshotAsMap } from "@baerly/server";
import {
  foldChunkedSnapshotReference,
  openSnapshotView,
  type ReferenceRow,
} from "@baerly/server/_internal/testing";
import {
  decodeWorkloadCeilingFixtureDescriptor,
  decodeWorkloadCeilingRunRequest,
  WORKLOAD_CEILING_CONTRACT_ID,
  workloadCeilingFixtureDescriptorKey,
  type WorkloadCeilingFixtureDescriptor,
  type WorkloadCeilingRunRequest,
} from "../../measurement/workload-ceiling-harness.ts";
import { constantTimeEqual } from "./constant-time-equal.ts";

/**
 * Requests this ISOLATE has served, module scope so it is per-isolate and
 * survives across requests. Read once per request, before the first `await`,
 * so two concurrent requests in one isolate cannot both observe zero.
 *
 * This is not a self-reported measurement and does not contradict README.md
 * §"Why CPU is never self-reported". No clock is read: the value is a boolean
 * about this isolate's own history, which the platform exposes nowhere and
 * which nothing outside the isolate can observe. CPU is different in kind —
 * an in-isolate CPU number is wall time misreported as the runtime's own
 * accounting, and the platform DOES publish the real one.
 */
let isolateRequestsServed = 0;

export interface WorkloadCeilingWorkerEnv {
  readonly BUCKET: R2Bucket;
  /**
   * Set via `wrangler secret put WORKLOAD_CEILING_SHARED_SECRET` — a
   * separate manual step that can be forgotten, so the binding is ABSENT at
   * runtime in exactly that failure mode. Never a `vars` literal. The fetch
   * handler fails closed on that absence (and on a blank value) rather than
   * letting an empty bearer token compare equal against an unset secret.
   */
  readonly WORKLOAD_CEILING_SHARED_SECRET: string | undefined;
}

class WorkloadCeilingWorkerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "WorkloadCeilingWorkerError";
    this.status = status;
  }
}

/**
 * Runs the descriptor through the SHARED harness codec, then restates any
 * rejection as a 502. The status matters: a malformed descriptor is a broken
 * upstream fixture, not a bad request from the caller (whose own body already
 * decoded cleanly), so it must never be reported as the caller's 400.
 */
function parseFixtureDescriptor(bytes: Uint8Array): WorkloadCeilingFixtureDescriptor {
  try {
    return decodeWorkloadCeilingFixtureDescriptor(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new WorkloadCeilingWorkerError(
      502,
      `fixture descriptor is unusable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The one Map → rows conversion, shared by every arm so its cost cancels in the comparison. */
const toReferenceRows = (materialized: Map<string, DocumentData>): readonly ReferenceRow[] =>
  [...materialized].map(([_id, body]) => ({ _id, body }));

/**
 * The control arm: the SHIPPED monolithic read path, verbatim. `loadSnapshotAsMap`
 * verifies the body's SHA-256 against the digest embedded in the key before any
 * field is parsed, which is precisely the hash cost this arm exists to include.
 */
async function loadMonolithicRows(
  storage: Storage,
  key: string,
  collection: string,
  signal: AbortSignal,
): Promise<readonly ReferenceRow[]> {
  try {
    return toReferenceRows(await loadSnapshotAsMap(storage, key, collection, signal));
  } catch (error) {
    signal.throwIfAborted();
    throw new WorkloadCeilingWorkerError(
      502,
      `monolithic fixture is unreadable: ${describeError(error)}`,
    );
  }
}

/**
 * The unhashed probe: identical bytes, identical key, identical decode — minus
 * the digest comparison. Deliberately a duplicate of `loadSnapshotAsMap`'s tail
 * rather than a flag threaded through the production reader: the production
 * reader must not grow a "skip verification" mode for a bench arm's benefit.
 */
async function loadMonolithicRowsUnhashed(
  storage: Storage,
  key: string,
  collection: string,
  signal: AbortSignal,
): Promise<readonly ReferenceRow[]> {
  const stored = await storage.get(key, { signal });
  if (stored === null) {
    throw new WorkloadCeilingWorkerError(502, `monolithic fixture body is missing: ${key}`);
  }
  // Everything loadSnapshotAsMap does EXCEPT `await snapshotHash(got.body)` and
  // the comparison against the key digest. Keep the rest byte-for-byte
  // equivalent — a divergence here shows up as hash cost that is not hash cost.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(stored.body));
  } catch (error) {
    throw new WorkloadCeilingWorkerError(
      502,
      `monolithic fixture body is not valid JSON: ${String(error)}`,
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("schema_version" in parsed) ||
    !("collection" in parsed) ||
    !("docs" in parsed) ||
    !Array.isArray((parsed as { docs?: unknown }).docs)
  ) {
    throw new WorkloadCeilingWorkerError(502, "monolithic fixture body is not a snapshot");
  }
  const body = parsed as {
    schema_version: number;
    collection: string;
    docs: readonly { _id: string; body: DocumentData }[];
  };
  if (body.collection !== collection) {
    throw new WorkloadCeilingWorkerError(502, "monolithic fixture body collection does not match");
  }
  const out = new Map<string, DocumentData>();
  for (const row of body.docs) {
    out.set(row._id, row.body);
  }
  return toReferenceRows(out);
}

async function loadChunkedRows(
  storage: Storage,
  descriptor: WorkloadCeilingFixtureDescriptor,
  signal: AbortSignal,
): Promise<readonly ReferenceRow[]> {
  const { collection } = descriptor;
  // A manifest or chunk the descriptor references but the bucket does not hold
  // is a broken upstream fixture — the same 502 the monolithic branch reports
  // for its missing body, so an operator reads one status class for "your
  // fixture is incomplete" regardless of which representation was requested.
  // Kernel errors are restated, never swallowed: `materialize` must not be
  // allowed to return a short row set, which would understate the candidate's
  // cost as a cheaper implementation.
  try {
    const view = await openSnapshotView({
      storage,
      manifestKey: descriptor.manifest_key,
      collection,
      expectedLogSeqStart: descriptor.log_seq_start,
      signal,
    });
    const materialized: Map<string, DocumentData> = await view.materialize(signal);
    return [...materialized].map(([_id, body]) => ({ _id, body }));
  } catch (error) {
    signal.throwIfAborted();
    throw new WorkloadCeilingWorkerError(
      502,
      `chunked fixture is unreadable: ${describeError(error)}`,
    );
  }
}

async function runControlledFold(
  storage: Storage,
  request: WorkloadCeilingRunRequest,
  signal: AbortSignal,
): Promise<{ readonly row_count: number }> {
  const descriptorKey = workloadCeilingFixtureDescriptorKey(request.fixture_prefix);
  const descriptorStored = await storage.get(descriptorKey, { signal });
  if (descriptorStored === null) {
    throw new WorkloadCeilingWorkerError(502, `fixture descriptor is missing: ${descriptorKey}`);
  }
  const descriptor = parseFixtureDescriptor(descriptorStored.body);
  let rows: readonly ReferenceRow[];
  switch (request.implementation) {
    case "monolithic-control": {
      rows = await loadMonolithicRows(
        storage,
        descriptor.monolithic_key,
        descriptor.collection,
        signal,
      );
      break;
    }
    case "monolithic-control-unhashed": {
      rows = await loadMonolithicRowsUnhashed(
        storage,
        descriptor.monolithic_key,
        descriptor.collection,
        signal,
      );
      break;
    }
    case "chunked-candidate": {
      rows = await loadChunkedRows(storage, descriptor, signal);
      break;
    }
    default: {
      const exhaustive: never = request.implementation;
      throw new WorkloadCeilingWorkerError(400, `unknown implementation: ${String(exhaustive)}`);
    }
  }
  const folded = foldChunkedSnapshotReference(rows, []);
  return { row_count: folded.length };
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default {
  async fetch(request: Request, env: WorkloadCeilingWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/run") {
      return jsonResponse(404, { error: "not found: POST /run only" });
    }

    const isolateCold = isolateRequestsServed === 0;
    isolateRequestsServed++;

    // Fail CLOSED, at the handler — auth policy lives here, not in the
    // comparator (`constant-time-equal.ts` deliberately pins empty-vs-empty
    // → true as comparator semantics). Without the secret-side checks an
    // unset binding makes `constantTimeEqual("", undefined)` compare zero
    // bytes to zero bytes and authenticate an empty bearer, and a blank
    // secret would accept a blank token the same way.
    const token = bearerToken(request);
    const secret = env.WORKLOAD_CEILING_SHARED_SECRET;
    if (
      token === null ||
      secret === undefined ||
      secret.trim() === "" ||
      !constantTimeEqual(token, secret)
    ) {
      return jsonResponse(401, { error: "unauthorized" });
    }

    let runRequest: WorkloadCeilingRunRequest;
    try {
      runRequest = decodeWorkloadCeilingRunRequest(await request.text());
    } catch (error) {
      return jsonResponse(400, { error: describeError(error) });
    }

    // Join identifiers, emitted EXACTLY ONCE. `workload-ceiling-collect.ts`
    // joins the platform's `workersInvocationsAdaptive` telemetry row to
    // this run by the fixed study Worker's `scriptName` plus a narrow time
    // window (see README.md); this Workers Logs line is what lets a study
    // reader independently confirm which run produced which telemetry row.
    console.log(
      JSON.stringify({
        workload_ceiling_run_id: runRequest.run_id,
        workload_ceiling_scenario_id: runRequest.scenario_id,
        workload_ceiling_implementation: runRequest.implementation,
        workload_ceiling_isolate_cold: isolateCold,
      }),
    );

    const storage = r2BindingStorage(env.BUCKET);
    try {
      // `request.signal` — not a hand-rolled controller that is never
      // aborted — so an aborted client connection actually cancels the
      // in-flight storage reads behind the fold.
      const result = await runControlledFold(storage, runRequest, request.signal);
      return jsonResponse(200, {
        contract_id: WORKLOAD_CEILING_CONTRACT_ID,
        run_id: runRequest.run_id,
        scenario_id: runRequest.scenario_id,
        implementation: runRequest.implementation,
        row_count: result.row_count,
        isolate_cold: isolateCold,
      });
    } catch (error) {
      const status = error instanceof WorkloadCeilingWorkerError ? error.status : 500;
      return jsonResponse(status, {
        error: describeError(error),
        run_id: runRequest.run_id,
        scenario_id: runRequest.scenario_id,
      });
    }
  },
} satisfies ExportedHandler<WorkloadCeilingWorkerEnv>;
