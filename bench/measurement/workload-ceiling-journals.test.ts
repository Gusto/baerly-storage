import { describe, expect, test } from "vitest";
import { encodeJsonBytes, snapshotHash } from "@baerly/protocol";
import {
  ARTIFACT_LIST_PAGE_SIZE,
  ARTIFACT_GC_EXPECTED_BODIES,
  CLOUDFLARE_FREE_OUTER_OPERATION_LIMIT,
  EXPECTED_WORKLOAD_CEILING_JOURNALS,
  PUBLISHER_EXPECTED_BODIES,
  type ChunkedStorageScenario,
  type ExpectedScenarioJournalStep,
  artifactDeleteAuthorityTupleSha256,
  validatesArtifactDeleteAuthority,
} from "./workload-ceiling-journals.ts";

const scenarios = [
  "cas-win",
  "cas-loss",
  "storage-retry",
  "orphan-mark",
  "artifact-fence-win",
  "artifact-fence-conflict",
  "artifact-fence-resume",
  "artifact-fence-exhausted",
  "bounded-list-page",
] as const;

const stepsOf = (scenario: ChunkedStorageScenario): readonly ExpectedScenarioJournalStep[] =>
  EXPECTED_WORKLOAD_CEILING_JOURNALS[scenario].steps;

describe("workload-ceiling storage journal fixtures", () => {
  test("pins one deeply immutable exact fixture for every scenario", () => {
    expect(Object.keys(EXPECTED_WORKLOAD_CEILING_JOURNALS)).toEqual(scenarios);

    for (const scenario of scenarios) {
      const fixture = EXPECTED_WORKLOAD_CEILING_JOURNALS[scenario];
      expect(fixture.scenario).toBe(scenario);
      expect(Object.isFrozen(fixture)).toBe(true);
      expect(Object.isFrozen(fixture.steps)).toBe(true);
      expect(fixture.steps.every(Object.isFrozen)).toBe(true);
      expect(fixture.outer_operation_count).toBe(fixture.steps.length);
      expect(fixture.outer_operation_count).toBeLessThanOrEqual(
        CLOUDFLARE_FREE_OUTER_OPERATION_LIMIT,
      );
    }
  });

  test("keeps each publisher attempt in the four durable phases", () => {
    for (const scenario of ["cas-win", "cas-loss", "storage-retry"] as const) {
      const fixture = EXPECTED_WORKLOAD_CEILING_JOURNALS[scenario];
      for (const attempt of fixture.publication_attempts) {
        const indexed = fixture.steps
          .map((step, index) => ({ step, index }))
          .filter(({ step }) => step.attempt_id === attempt.attempt_id);
        const chunkPuts = indexed.filter(
          ({ step }) => step.method === "put" && step.key_class === "chunk",
        );
        const manifestPut = indexed.find(
          ({ step }) => step.method === "put" && step.key_class === "manifest",
        );
        const headCas = indexed.find(
          ({ step }) =>
            step.method === "put" && step.key_class === "current" && step.condition === "if-match",
        );

        expect(chunkPuts.length).toBeGreaterThan(0);
        expect(manifestPut).toBeDefined();
        expect(headCas).toBeDefined();
        expect(Math.max(...chunkPuts.map(({ index }) => index))).toBeLessThan(
          manifestPut?.index ?? -1,
        );
        expect(manifestPut?.index).toBeLessThan(headCas?.index ?? -1);
        expect(
          indexed.filter(
            ({ step, index }) =>
              index > (headCas?.index ?? -1) &&
              step.method === "put" &&
              (step.key_class === "chunk" || step.key_class === "manifest"),
          ),
        ).toEqual([]);
      }
    }
  });

  test("retains one incarnation for a storage retry and mints a new one on restart", () => {
    const retry = EXPECTED_WORKLOAD_CEILING_JOURNALS["storage-retry"];
    expect(retry.publication_attempts).toHaveLength(1);
    const retryChunkPuts = retry.steps.filter(
      (step) => step.method === "put" && step.key_class === "chunk",
    );
    expect(retryChunkPuts.map((step) => step.key)).toEqual([
      retryChunkPuts[0]?.key,
      retryChunkPuts[0]?.key,
    ]);
    expect(retryChunkPuts.map((step) => step.outcome)).toEqual(["error", "ok"]);

    const loss = EXPECTED_WORKLOAD_CEILING_JOURNALS["cas-loss"];
    expect(loss.publication_attempts).toHaveLength(2);
    const [first, restarted] = loss.publication_attempts;
    expect(first?.incarnation).not.toBe(restarted?.incarnation);
    const artifactKeysByAttempt = new Map<string, Set<string>>();
    for (const attempt of loss.publication_attempts) {
      const artifactPuts = loss.steps.filter(
        (step) =>
          step.attempt_id === attempt.attempt_id &&
          step.method === "put" &&
          (step.key_class === "chunk" || step.key_class === "manifest"),
      );
      expect(artifactPuts.every((step) => step.key?.includes(attempt.incarnation))).toBe(true);
      artifactKeysByAttempt.set(
        attempt.attempt_id,
        new Set(artifactPuts.flatMap((step) => (step.key === undefined ? [] : [step.key]))),
      );
    }
    const firstKeys = artifactKeysByAttempt.get(first?.attempt_id ?? "missing") ?? new Set();
    const restartedKeys =
      artifactKeysByAttempt.get(restarted?.attempt_id ?? "missing") ?? new Set();
    expect(firstKeys.intersection(restartedKeys)).toEqual(new Set());
  });

  test("binds every publisher attempt to its captured head and canonical PUT bodies", async () => {
    type PublisherFixtureProjection = {
      readonly publisher_bodies?: Readonly<Record<string, unknown>>;
    };
    type PublisherStepProjection = ExpectedScenarioJournalStep & {
      readonly put_body_id?: string;
    };

    for (const scenario of ["cas-win", "cas-loss", "storage-retry"] as const) {
      const fixture = EXPECTED_WORKLOAD_CEILING_JOURNALS[scenario];
      const publisherBodies = (fixture as typeof fixture & PublisherFixtureProjection)
        .publisher_bodies;
      expect(publisherBodies).toBeDefined();

      for (const attempt of fixture.publication_attempts) {
        const attemptSteps = stepsOf(scenario).filter(
          (step) => step.attempt_id === attempt.attempt_id,
        );
        const headGet = attemptSteps.find(
          (step) => step.method === "get" && step.key_class === "current",
        );
        const headCas = attemptSteps.find(
          (step) => step.method === "put" && step.key_class === "current",
        );
        expect(headGet?.result_etag).toBe(headCas?.if_match);

        for (const step of attemptSteps.filter((entry) => entry.method === "put")) {
          const bodyId = (step as PublisherStepProjection).put_body_id;
          expect(bodyId).toBeDefined();
          if (bodyId === undefined || publisherBodies === undefined) {
            continue;
          }
          const body = publisherBodies[bodyId];
          expect(body).toBeDefined();
          if (body !== undefined) {
            await expect(snapshotHash(encodeJsonBytes(body))).resolves.toBe(step.put_sha256);
            if (step.key_class === "chunk" || step.key_class === "manifest") {
              expect(step.key).toContain(`/sha256/${step.put_sha256 ?? "missing"}.json`);
            }
          }
        }
      }
    }

    const retry = stepsOf("storage-retry").filter(
      (step) => step.method === "put" && step.key_class === "chunk",
    ) as readonly PublisherStepProjection[];
    expect(
      retry.map((step) => [
        step.key,
        step.incarnation,
        step.put_body_id,
        step.put_sha256,
        step.if_none_match,
      ]),
    ).toEqual([
      [
        retry[0]?.key,
        retry[0]?.incarnation,
        retry[0]?.put_body_id,
        retry[0]?.put_sha256,
        retry[0]?.if_none_match,
      ],
      [
        retry[0]?.key,
        retry[0]?.incarnation,
        retry[0]?.put_body_id,
        retry[0]?.put_sha256,
        retry[0]?.if_none_match,
      ],
    ]);

    const loss = EXPECTED_WORKLOAD_CEILING_JOURNALS["cas-loss"];
    const [lost, restarted] = loss.publication_attempts;
    const currentPutFor = (attemptId: string | undefined): PublisherStepProjection | undefined =>
      stepsOf("cas-loss").find(
        (step) =>
          step.attempt_id === attemptId && step.method === "put" && step.key_class === "current",
      );
    expect(currentPutFor(lost?.attempt_id)?.put_body_id).not.toBe(
      currentPutFor(restarted?.attempt_id)?.put_body_id,
    );
    expect(currentPutFor(lost?.attempt_id)?.put_sha256).not.toBe(
      currentPutFor(restarted?.attempt_id)?.put_sha256,
    );
    const currentGetFor = (
      attemptId: string | undefined,
    ): ExpectedScenarioJournalStep | undefined =>
      stepsOf("cas-loss").find(
        (step) =>
          step.attempt_id === attemptId && step.method === "get" && step.key_class === "current",
      );
    expect(currentGetFor(lost?.attempt_id)?.result_etag).not.toBe(
      currentGetFor(restarted?.attempt_id)?.result_etag,
    );

    const before = PUBLISHER_EXPECTED_BODIES["current-before-publish"];
    const assertCurrentTransition = (
      current: {
        readonly schema_version: number;
        readonly layout_version: number;
        readonly collection: string;
        readonly snapshot: string;
        readonly log_seq_start: number;
        readonly snapshot_bytes: number;
        readonly snapshot_rows: number;
        readonly tail_hint: number;
        readonly writer_fence: typeof before.writer_fence;
        readonly generation: string;
        readonly artifact_gc_epoch: number;
      },
      manifest: {
        readonly collection: string;
        readonly log_seq_start: number;
        readonly chunks: readonly {
          readonly byte_length: number;
          readonly row_count: number;
        }[];
      },
      expectedManifestKey: string | undefined,
      captured: {
        readonly tail_hint: number;
        readonly writer_fence: typeof before.writer_fence;
        readonly generation: string;
        readonly artifact_gc_epoch: number;
      },
    ): void => {
      expect(current.schema_version).toBe(4);
      expect(current.layout_version).toBe(2);
      expect(current.collection).toBe(manifest.collection);
      expect(current.snapshot).toBe(expectedManifestKey);
      expect(current.log_seq_start).toBe(manifest.log_seq_start);
      expect(current.snapshot_bytes).toBe(
        manifest.chunks.reduce((sum, descriptor) => sum + descriptor.byte_length, 0),
      );
      expect(current.snapshot_rows).toBe(
        manifest.chunks.reduce((sum, descriptor) => sum + descriptor.row_count, 0),
      );
      expect(current.tail_hint).toBe(captured.tail_hint);
      expect(current.writer_fence).toEqual(captured.writer_fence);
      expect(current.generation).toBe(captured.generation);
      expect(current.artifact_gc_epoch).toBe(captured.artifact_gc_epoch);
    };
    const casWinManifestKey = stepsOf("cas-win").find(
      (step) => step.method === "put" && step.key_class === "manifest",
    )?.key;
    assertCurrentTransition(
      PUBLISHER_EXPECTED_BODIES["current-a"],
      PUBLISHER_EXPECTED_BODIES["manifest-a"],
      casWinManifestKey,
      before,
    );
    const restartedManifestKey = stepsOf("cas-loss").find(
      (step) =>
        step.attempt_id === restarted?.attempt_id &&
        step.method === "put" &&
        step.key_class === "manifest",
    )?.key;
    assertCurrentTransition(
      PUBLISHER_EXPECTED_BODIES["current-b"],
      PUBLISHER_EXPECTED_BODIES["manifest-b"],
      restartedManifestKey,
      PUBLISHER_EXPECTED_BODIES["current-after-winner"],
    );

    const encodedLength = (value: unknown): number => encodeJsonBytes(value).byteLength;
    expect(
      PUBLISHER_EXPECTED_BODIES["manifest-a"].chunks.map((chunk) => chunk.byte_length),
    ).toEqual([
      encodedLength(PUBLISHER_EXPECTED_BODIES["chunk-a1"]),
      encodedLength(PUBLISHER_EXPECTED_BODIES["chunk-a2"]),
    ]);
    expect(PUBLISHER_EXPECTED_BODIES["manifest-b"].chunks[0]?.byte_length).toBe(
      encodedLength(PUBLISHER_EXPECTED_BODIES["chunk-b"]),
    );
  });

  test("pins the fence-win, conflict, resume, and exhaustion journals exactly", () => {
    expect(
      stepsOf("artifact-fence-win").map(({ method, key_class, condition, outcome }) => ({
        method,
        key_class,
        condition,
        outcome,
      })),
    ).toEqual([
      { method: "get", key_class: "current", condition: undefined, outcome: "ok" },
      { method: "get", key_class: "manifest", condition: undefined, outcome: "ok" },
      { method: "put", key_class: "current", condition: "if-match", outcome: "ok" },
      { method: "put", key_class: "gc-pending", condition: "if-match", outcome: "ok" },
      { method: "delete", key_class: "chunk", condition: undefined, outcome: "ok" },
      { method: "delete", key_class: "manifest", condition: undefined, outcome: "ok" },
      { method: "put", key_class: "gc-pending", condition: "if-match", outcome: "ok" },
    ]);

    expect(
      EXPECTED_WORKLOAD_CEILING_JOURNALS["artifact-fence-conflict"].steps.map(
        ({ method, key_class, outcome }) => [method, key_class, outcome],
      ),
    ).toEqual([
      ["get", "current", "ok"],
      ["get", "manifest", "ok"],
      ["put", "current", "conflict"],
      ["get", "current", "ok"],
      ["get", "manifest", "ok"],
    ]);

    const resume = EXPECTED_WORKLOAD_CEILING_JOURNALS["artifact-fence-resume"];
    expect(resume.steps[0]).toMatchObject({ method: "get", key_class: "gc-pending" });
    expect(resume.steps.slice(1, 5).map((step) => [step.method, step.key_class])).toEqual([
      ["get", "current"],
      ["get", "manifest"],
      ["put", "current"],
      ["put", "gc-pending"],
    ]);
    expect(resume.delete_authority?.candidate_keys).toEqual(
      resume.resumed_from_authority?.candidate_keys,
    );
    expect(resume.delete_authority?.artifact_gc_epoch).toBe(
      (resume.resumed_from_authority?.artifact_gc_epoch ?? -1) + 1,
    );

    const exhausted = EXPECTED_WORKLOAD_CEILING_JOURNALS["artifact-fence-exhausted"];
    expect(exhausted.captured_artifact_gc_epoch).toBe(Number.MAX_SAFE_INTEGER);
    expect(stepsOf("artifact-fence-exhausted").some((step) => step.method === "put")).toBe(false);
    expect(stepsOf("artifact-fence-exhausted").some((step) => step.method === "delete")).toBe(
      false,
    );
  });

  test("ties every DELETE to the exact fenced authority and counts every outer operation", () => {
    for (const scenario of ["artifact-fence-win", "artifact-fence-resume"] as const) {
      const fixture = EXPECTED_WORKLOAD_CEILING_JOURNALS[scenario];
      const authority = fixture.delete_authority;
      expect(authority).toBeDefined();
      expect(fixture.delete_authorized).toBe(true);
      expect(
        fixture.steps.filter((step) => step.method === "delete").map((step) => step.key),
      ).toEqual(authority?.candidate_keys);

      const accounted = stepsOf(scenario).reduce(
        (count, step) =>
          count +
          Number(
            step.method === "get" ||
              step.method === "put" ||
              step.method === "delete" ||
              step.method === "list",
          ),
        0,
      );
      expect(accounted).toBe(fixture.outer_operation_count);
    }

    expect(
      EXPECTED_WORKLOAD_CEILING_JOURNALS["artifact-fence-resume"].steps.filter(
        (step) => step.method === "get" && step.key_class === "gc-pending",
      ),
    ).toHaveLength(1);
  });

  test("validates the canonical authority digest and rejects corrupt or unfenced pending state", async () => {
    const authority = EXPECTED_WORKLOAD_CEILING_JOURNALS["artifact-fence-win"].delete_authority;
    expect(authority).toBeDefined();
    if (authority === undefined) {
      return;
    }

    await expect(
      artifactDeleteAuthorityTupleSha256({
        artifact_gc_epoch: authority.artifact_gc_epoch,
        fence_etag: authority.fence_etag,
        candidate_keys: authority.candidate_keys,
      }),
    ).resolves.toBe(authority.tuple_sha256);
    await expect(
      validatesArtifactDeleteAuthority(authority, {
        artifact_gc_epoch: authority.artifact_gc_epoch,
        fence_etag: authority.fence_etag,
        collection_prefix: "tenants/study/collections/items",
      }),
    ).resolves.toBe(true);
    await expect(
      validatesArtifactDeleteAuthority(
        { ...authority, tuple_sha256: "0".repeat(64) },
        {
          artifact_gc_epoch: authority.artifact_gc_epoch,
          fence_etag: authority.fence_etag,
          collection_prefix: "tenants/study/collections/items",
        },
      ),
    ).resolves.toBe(false);
    await expect(
      validatesArtifactDeleteAuthority(authority, {
        artifact_gc_epoch: authority.artifact_gc_epoch + 1,
        fence_etag: authority.fence_etag,
        collection_prefix: "tenants/study/collections/items",
      }),
    ).resolves.toBe(false);
    await expect(
      validatesArtifactDeleteAuthority(authority, {
        artifact_gc_epoch: authority.artifact_gc_epoch,
        fence_etag: '"different-fence"',
        collection_prefix: "tenants/study/collections/items",
      }),
    ).resolves.toBe(false);

    const crossCollectionKey = authority.candidate_keys[0]?.replace(
      "tenants/study/collections/items/",
      "tenants/study/collections/other/",
    );
    expect(crossCollectionKey).toBeDefined();
    if (crossCollectionKey === undefined) {
      return;
    }
    const crossCollectionTuple = {
      artifact_gc_epoch: authority.artifact_gc_epoch,
      fence_etag: authority.fence_etag,
      candidate_keys: [crossCollectionKey],
    } as const;
    const crossCollectionAuthority = {
      ...crossCollectionTuple,
      tuple_sha256: await artifactDeleteAuthorityTupleSha256(crossCollectionTuple),
    };
    await expect(
      validatesArtifactDeleteAuthority(crossCollectionAuthority, {
        artifact_gc_epoch: authority.artifact_gc_epoch,
        fence_etag: authority.fence_etag,
        collection_prefix: "tenants/study/collections/items",
      }),
    ).resolves.toBe(false);
    await expect(
      validatesArtifactDeleteAuthority(authority, {
        artifact_gc_epoch: authority.artifact_gc_epoch,
        fence_etag: authority.fence_etag,
        collection_prefix: "",
      }),
    ).resolves.toBe(false);
  });

  test("pins exact If-Match tokens and canonical bytes for every PUT", async () => {
    for (const scenario of scenarios) {
      for (const step of stepsOf(scenario)) {
        if (step.method !== "put") {
          continue;
        }
        expect(step.put_sha256).toMatch(/^[0-9a-f]{64}$/);
        if (step.condition === "if-match") {
          expect(step.if_match).toMatch(/^".+"$/);
          expect(step.if_none_match).toBeUndefined();
        } else if (step.condition === "if-none-match") {
          expect(step.if_none_match).toBe("*");
          expect(step.if_match).toBeUndefined();
        }
      }
    }

    const before = ARTIFACT_GC_EXPECTED_BODIES.current_before_fence;
    const after = ARTIFACT_GC_EXPECTED_BODIES.current_after_fence;
    const { artifact_gc_epoch: beforeEpoch, ...beforeRest } = before;
    const { artifact_gc_epoch: afterEpoch, ...afterRest } = after;
    expect(afterRest).toEqual(beforeRest);
    expect(afterEpoch).toBe(beforeEpoch + 1);
    const { artifact_gc_epoch: resumedEpoch, ...resumedRest } =
      ARTIFACT_GC_EXPECTED_BODIES.current_after_resume_fence;
    expect(resumedRest).toEqual(afterRest);
    expect(resumedEpoch).toBe(afterEpoch + 1);

    const winSteps = stepsOf("artifact-fence-win");
    const winPuts = winSteps.filter((step) => step.method === "put");
    await expect(snapshotHash(encodeJsonBytes(after))).resolves.toBe(winPuts[0]?.put_sha256);
    await expect(
      snapshotHash(encodeJsonBytes(ARTIFACT_GC_EXPECTED_BODIES.pending_authority_8)),
    ).resolves.toBe(winPuts[1]?.put_sha256);
    await expect(
      snapshotHash(encodeJsonBytes(ARTIFACT_GC_EXPECTED_BODIES.pending_completion)),
    ).resolves.toBe(winPuts[2]?.put_sha256);

    expect(
      winPuts.map(({ key, if_match, put_sha256 }) => ({
        key,
        options: { if_match },
        put: { sha256: put_sha256 },
      })),
    ).toEqual([
      {
        key: "tenants/study/collections/items/current.json",
        options: { if_match: '"head-epoch-7"' },
        put: { sha256: winPuts[0]?.put_sha256 },
      },
      {
        key: "tenants/study/collections/items/gc/pending.json",
        options: { if_match: '"pending-before-fence"' },
        put: { sha256: winPuts[1]?.put_sha256 },
      },
      {
        key: "tenants/study/collections/items/gc/pending.json",
        options: { if_match: '"pending-authority-8"' },
        put: { sha256: winPuts[2]?.put_sha256 },
      },
    ]);
    expect(winSteps[0]?.result_etag).toBe(winPuts[0]?.if_match);
    expect(winPuts[0]?.result_etag).toBe(
      EXPECTED_WORKLOAD_CEILING_JOURNALS["artifact-fence-win"].delete_authority.fence_etag,
    );
    expect(winPuts[1]?.result_etag).toBe(winPuts[2]?.if_match);

    const resumeSteps = stepsOf("artifact-fence-resume");
    const resumePuts = resumeSteps.filter((step) => step.method === "put");
    await expect(
      snapshotHash(encodeJsonBytes(ARTIFACT_GC_EXPECTED_BODIES.current_after_resume_fence)),
    ).resolves.toBe(resumePuts[0]?.put_sha256);
    await expect(
      snapshotHash(encodeJsonBytes(ARTIFACT_GC_EXPECTED_BODIES.pending_authority_9)),
    ).resolves.toBe(resumePuts[1]?.put_sha256);
    await expect(
      snapshotHash(encodeJsonBytes(ARTIFACT_GC_EXPECTED_BODIES.pending_completion)),
    ).resolves.toBe(resumePuts[2]?.put_sha256);
    expect(resumePuts.map((step) => step.if_match)).toEqual([
      '"head-epoch-8"',
      '"pending-authority-8"',
      '"pending-authority-9"',
    ]);
    expect(resumeSteps[0]?.result_etag).toBe(resumePuts[1]?.if_match);
    expect(resumeSteps[1]?.result_etag).toBe(resumePuts[0]?.if_match);
    expect(resumePuts[0]?.result_etag).toBe(
      EXPECTED_WORKLOAD_CEILING_JOURNALS["artifact-fence-resume"].delete_authority.fence_etag,
    );
    expect(resumePuts[1]?.result_etag).toBe(resumePuts[2]?.if_match);
  });

  test("hashes durable fixtures as explicit insertion-order protocol bytes", async () => {
    const chunkA1 = PUBLISHER_EXPECTED_BODIES["chunk-a1"];
    expect(new TextDecoder().decode(encodeJsonBytes(chunkA1))).toBe(
      '{"schema_version":2,"collection":"items","incarnation":"11111111111111111111111111111111","first_id":"a","last_id":"m","docs":[{"_id":"a","value":"alpha"},{"_id":"m","value":"middle"}]}',
    );

    for (const scenario of ["cas-win", "cas-loss", "storage-retry"] as const) {
      const fixture = EXPECTED_WORKLOAD_CEILING_JOURNALS[scenario];
      const bodies: Readonly<Record<string, unknown>> = fixture.publisher_bodies;
      for (const step of stepsOf(scenario).filter((entry) => entry.method === "put")) {
        expect(step.put_body_id).toBeDefined();
        if (step.put_body_id !== undefined) {
          const body = bodies[step.put_body_id];
          expect(body).toBeDefined();
          if (body !== undefined) {
            await expect(snapshotHash(encodeJsonBytes(body))).resolves.toBe(step.put_sha256);
          }
        }
      }
    }

    const authority = EXPECTED_WORKLOAD_CEILING_JOURNALS["artifact-fence-win"].delete_authority;
    const authorityTuple = {
      artifact_gc_epoch: authority.artifact_gc_epoch,
      fence_etag: authority.fence_etag,
      candidate_keys: authority.candidate_keys,
    } as const;
    expect(new TextDecoder().decode(encodeJsonBytes(authorityTuple))).toBe(
      `{"artifact_gc_epoch":8,"fence_etag":"\\"head-epoch-8\\"","candidate_keys":["${authority.candidate_keys[0] ?? "missing"}","${authority.candidate_keys[1] ?? "missing"}"]}`,
    );
    await expect(snapshotHash(encodeJsonBytes(authorityTuple))).resolves.toBe(
      authority.tuple_sha256,
    );

    const winPuts = stepsOf("artifact-fence-win").filter((step) => step.method === "put");
    for (const [step, body] of [
      [winPuts[0], ARTIFACT_GC_EXPECTED_BODIES.current_after_fence],
      [winPuts[1], ARTIFACT_GC_EXPECTED_BODIES.pending_authority_8],
      [winPuts[2], ARTIFACT_GC_EXPECTED_BODIES.pending_completion],
    ] as const) {
      await expect(snapshotHash(encodeJsonBytes(body))).resolves.toBe(step?.put_sha256);
    }
  });

  test("uses an explicit bounded LIST page size and never treats discovery as authority", () => {
    const bounded = EXPECTED_WORKLOAD_CEILING_JOURNALS["bounded-list-page"];
    const listSteps = bounded.steps.filter((step) => step.method === "list");
    expect(listSteps).toHaveLength(2);
    expect(listSteps.every((step) => step.max_keys === ARTIFACT_LIST_PAGE_SIZE)).toBe(true);
    expect(listSteps.every((step) => step.max_keys !== undefined && step.max_keys > 0)).toBe(true);

    const marked = EXPECTED_WORKLOAD_CEILING_JOURNALS["orphan-mark"];
    expect(marked.delete_authorized).toBe(false);
    expect(stepsOf("orphan-mark").some((step) => step.method === "delete")).toBe(false);
    expect(stepsOf("orphan-mark").some((step) => step.method === "put")).toBe(false);
  });
});
