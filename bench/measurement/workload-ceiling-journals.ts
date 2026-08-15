import { encodeJsonBytes, snapshotHash } from "@baerly/protocol";

export type ChunkedStorageScenario =
  | "cas-win"
  | "cas-loss"
  | "storage-retry"
  | "orphan-mark"
  | "artifact-fence-win"
  | "artifact-fence-conflict"
  | "artifact-fence-resume"
  | "artifact-fence-exhausted"
  | "bounded-list-page";

export interface ExpectedJournalStep {
  readonly method: "get" | "put" | "delete" | "list";
  readonly key_class: "current" | "manifest" | "chunk" | "gc-pending" | "artifact-prefix";
  readonly condition?: "if-match" | "if-none-match";
  readonly outcome: "ok" | "conflict" | "error";
}

export interface ExpectedArtifactDeleteAuthority {
  readonly artifact_gc_epoch: number;
  readonly fence_etag: string;
  readonly candidate_keys: readonly string[];
  readonly tuple_sha256: string;
}

/** Exact-key metadata used when normalizing a concrete Storage journal. */
export interface ExpectedScenarioJournalStep extends ExpectedJournalStep {
  readonly key?: string;
  readonly attempt_id?: string;
  readonly incarnation?: string;
  readonly max_keys?: number;
  readonly if_match?: string;
  readonly if_none_match?: "*";
  readonly put_sha256?: string;
  readonly put_body_id?: string;
  readonly result_etag?: string;
}

export interface ExpectedPublicationAttempt {
  readonly attempt_id: string;
  readonly incarnation: string;
}

export const CLOUDFLARE_FREE_OUTER_OPERATION_LIMIT = 50;
export const ARTIFACT_LIST_PAGE_SIZE = 32;

const COLLECTION_PREFIX = "tenants/study/collections/items";
const CURRENT_KEY = `${COLLECTION_PREFIX}/current.json`;
const PENDING_KEY = `${COLLECTION_PREFIX}/gc/pending.json`;
const CAPTURED_INCARNATION = "00000000000000000000000000000000";
const INCARNATION_A = "11111111111111111111111111111111";
const INCARNATION_B = "22222222222222222222222222222222";
const INCARNATION_C = "33333333333333333333333333333333";
const WINNER_INCARNATION = "44444444444444444444444444444444";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const PUBLISH_CHUNK_A1_SHA256 = "45c800e509b91ae5722ef1d036d7b93c5a11305bc5ac9945b7dc59219898dad6";
const PUBLISH_CHUNK_A2_SHA256 = "2f63343b2a27ddd3db5b75f0b331d0847ff60dd62582fa0723db124b91ab6f72";
const PUBLISH_CHUNK_B_SHA256 = "ee07043308d45ac1a95880ffbdd627f4c715989af9169616007e544686b56c23";
const PUBLISH_MANIFEST_A_SHA256 =
  "025745adb81c417a5de5cb8e78e2fc878fa68dd64b10f90fdc7f0d900ef1e141";
const PUBLISH_MANIFEST_B_SHA256 =
  "8f197009ca0937f9331bc08809087f03c7cf0372060e7440b7ab6ccbdad4209a";
const PUBLISH_CURRENT_A_SHA256 = "518009ea4217972c8feff45bcba1f233ef68a26da01f90700dfb6aa1c47478c3";
const PUBLISH_CURRENT_B_SHA256 = "0710ed851ddd95a4600e02b34ea2bb54659d9b8544dc8a91e8b474574dc79784";

const chunkKey = (incarnation: string, digest: string): string =>
  `${COLLECTION_PREFIX}/_v2/snapshot/chunks/${incarnation}/sha256/${digest}.json`;
const manifestKey = (incarnation: string, digest: string): string =>
  `${COLLECTION_PREFIX}/_v2/snapshot/manifests/${incarnation}/sha256/${digest}.json`;

const CHUNK_A = chunkKey(INCARNATION_A, PUBLISH_CHUNK_A1_SHA256);
const CHUNK_B = chunkKey(INCARNATION_A, PUBLISH_CHUNK_A2_SHA256);
const MANIFEST_A = manifestKey(INCARNATION_A, PUBLISH_MANIFEST_A_SHA256);
const CHUNK_C = chunkKey(INCARNATION_B, PUBLISH_CHUNK_B_SHA256);
const MANIFEST_B = manifestKey(INCARNATION_B, PUBLISH_MANIFEST_B_SHA256);
const CAPTURED_MANIFEST = manifestKey(CAPTURED_INCARNATION, DIGEST_D);
const WINNER_MANIFEST = manifestKey(WINNER_INCARNATION, DIGEST_C);
const ORPHAN_CHUNK = chunkKey(INCARNATION_C, DIGEST_A);
const ORPHAN_MANIFEST = manifestKey(INCARNATION_C, DIGEST_B);

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
};

const defineFixture = <
  const T extends {
    readonly scenario: ChunkedStorageScenario;
    readonly steps: readonly ExpectedScenarioJournalStep[];
  },
>(
  fixture: T,
): T & { readonly outer_operation_count: number } =>
  deepFreeze({ ...fixture, outer_operation_count: fixture.steps.length });

interface ArtifactDeleteAuthorityTuple {
  readonly artifact_gc_epoch: number;
  readonly fence_etag: string;
  readonly candidate_keys: readonly string[];
}

export const artifactDeleteAuthorityTupleSha256 = (
  tuple: ArtifactDeleteAuthorityTuple,
): Promise<string> =>
  snapshotHash(
    encodeJsonBytes({
      artifact_gc_epoch: tuple.artifact_gc_epoch,
      fence_etag: tuple.fence_etag,
      candidate_keys: tuple.candidate_keys,
    }),
  );

const ARTIFACT_KEY_SUFFIX_PATTERN =
  /^\/_v2\/snapshot\/(?:chunks\/[0-9a-f]{32}|manifests\/[0-9a-f]{32})\/sha256\/[0-9a-f]{64}\.json$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const isValidCollectionPrefix = (prefix: string): boolean =>
  prefix.length > 0 &&
  !prefix.startsWith("/") &&
  !prefix.endsWith("/") &&
  !prefix.includes("//") &&
  !prefix.includes("\\") &&
  ![...prefix].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f || (codePoint >= 0xd800 && codePoint <= 0xdfff);
  }) &&
  prefix.split("/").every((segment) => segment !== "." && segment !== "..");

/** Fail-closed validation for benchmark fixtures modelling persisted authority. */
export const validatesArtifactDeleteAuthority = async (
  authority: ExpectedArtifactDeleteAuthority,
  fencedHead: {
    readonly artifact_gc_epoch: number;
    readonly fence_etag: string;
    readonly collection_prefix: string;
  },
): Promise<boolean> => {
  if (
    !Number.isSafeInteger(authority.artifact_gc_epoch) ||
    authority.artifact_gc_epoch < 0 ||
    authority.artifact_gc_epoch !== fencedHead.artifact_gc_epoch ||
    authority.fence_etag !== fencedHead.fence_etag ||
    authority.fence_etag.length === 0 ||
    authority.candidate_keys.length === 0 ||
    !isValidCollectionPrefix(fencedHead.collection_prefix) ||
    !SHA256_PATTERN.test(authority.tuple_sha256)
  ) {
    return false;
  }
  const sortedUnique = [...new Set(authority.candidate_keys)].toSorted();
  if (
    sortedUnique.length !== authority.candidate_keys.length ||
    !sortedUnique.every((key, index) => key === authority.candidate_keys[index]) ||
    !sortedUnique.every(
      (key) =>
        key.startsWith(fencedHead.collection_prefix) &&
        ARTIFACT_KEY_SUFFIX_PATTERN.test(key.slice(fencedHead.collection_prefix.length)),
    )
  ) {
    return false;
  }
  return (await artifactDeleteAuthorityTupleSha256(authority)) === authority.tuple_sha256;
};

const FENCE_WIN_AUTHORITY = deepFreeze({
  artifact_gc_epoch: 8,
  fence_etag: '"head-epoch-8"',
  candidate_keys: [ORPHAN_CHUNK, ORPHAN_MANIFEST],
  tuple_sha256: "a397309f5a6fb788666d5f99a5cc1b3d418e09b7209f1e8fd214f32f42abf2be",
} as const satisfies ExpectedArtifactDeleteAuthority);

const RESUMED_FROM_AUTHORITY = deepFreeze({
  artifact_gc_epoch: 8,
  fence_etag: '"head-epoch-8"',
  candidate_keys: [ORPHAN_MANIFEST],
  tuple_sha256: "8adae8c0e886017f18f5946b83a6ded2541e68637aaba232b06499889ae2662d",
} as const satisfies ExpectedArtifactDeleteAuthority);

const RESUME_DELETE_AUTHORITY = deepFreeze({
  artifact_gc_epoch: 9,
  fence_etag: '"head-epoch-9"',
  candidate_keys: [ORPHAN_MANIFEST],
  tuple_sha256: "b9e0939aad1745a8cab4737ad2e712a72c772bb75a9ba0ddb08be57057f55de5",
} as const satisfies ExpectedArtifactDeleteAuthority);

const CURRENT_BEFORE_FENCE = deepFreeze({
  schema_version: 4,
  collection: "items",
  layout_version: 2,
  snapshot: CAPTURED_MANIFEST,
  tail_hint: 150,
  log_seq_start: 100,
  writer_fence: {
    epoch: 5,
    owner: "study-worker@fixture",
    claimed_at: "2026-08-14T00:00:00.000Z",
    lease_until: "2026-08-14T00:05:00.000Z",
  },
  snapshot_bytes: 786_432,
  snapshot_rows: 2_048,
  mean_entry_bytes: 384,
  last_warned_seq: 120,
  log_delete_floor: 84,
  generation: "study-generation-7",
  artifact_gc_epoch: 7,
} as const);

const CURRENT_AFTER_FENCE = deepFreeze({ ...CURRENT_BEFORE_FENCE, artifact_gc_epoch: 8 } as const);
const CURRENT_AFTER_RESUME_FENCE = deepFreeze({
  ...CURRENT_AFTER_FENCE,
  artifact_gc_epoch: 9,
} as const);

export const ARTIFACT_GC_EXPECTED_BODIES = deepFreeze({
  current_before_fence: CURRENT_BEFORE_FENCE,
  current_after_fence: CURRENT_AFTER_FENCE,
  current_after_resume_fence: CURRENT_AFTER_RESUME_FENCE,
  pending_authority_8: {
    schema: "baerly.artifact-delete-authority/v1",
    authority: FENCE_WIN_AUTHORITY,
  },
  pending_authority_9: {
    schema: "baerly.artifact-delete-authority/v1",
    authority: RESUME_DELETE_AUTHORITY,
  },
  pending_completion: {
    schema: "baerly.artifact-delete-authority/v1",
    authority: null,
  },
} as const);

const CURRENT_AFTER_FENCE_SHA256 =
  "dd4f966a2ac7f68258f3bc56784a0cbb1307685dfffe1070a5547d607c3215e2";
const CURRENT_AFTER_RESUME_FENCE_SHA256 =
  "b6db369edbe50aacb5d8b9558609d0a5eec952649dd3b48cd7e82c897d3d646f";
const PENDING_AUTHORITY_8_SHA256 =
  "33c7f6841b8575d3ae1d73b45aa8296313ddc94872bfdc9d8c57bf701c3bf163";
const PENDING_AUTHORITY_9_SHA256 =
  "abd039e3a30e5a2a10a5d8c0ca4013d7756f7faba597dd0260aef0668fc40975";
const PENDING_COMPLETION_SHA256 =
  "42ef0f40ee5a68a6b09a28080a618bfa71694da00e30d866e29ff94b6987903b";

const PUBLISH_CHUNK_A1_BODY = deepFreeze({
  schema_version: 2,
  collection: "items",
  incarnation: INCARNATION_A,
  first_id: "a",
  last_id: "m",
  docs: [
    { _id: "a", value: "alpha" },
    { _id: "m", value: "middle" },
  ],
} as const);

const PUBLISH_CHUNK_A2_BODY = deepFreeze({
  schema_version: 2,
  collection: "items",
  incarnation: INCARNATION_A,
  first_id: "n",
  last_id: "z",
  docs: [
    { _id: "n", value: "next" },
    { _id: "z", value: "omega" },
  ],
} as const);

const PUBLISH_CHUNK_B_BODY = deepFreeze({
  schema_version: 2,
  collection: "items",
  incarnation: INCARNATION_B,
  first_id: "a",
  last_id: "z",
  docs: [
    { _id: "a", value: "alpha-2" },
    { _id: "z", value: "omega-2" },
  ],
} as const);

const PUBLISH_MANIFEST_A_BODY = deepFreeze({
  schema_version: 2,
  collection: "items",
  log_seq_start: 120,
  incarnation: INCARNATION_A,
  collation: "utf8-scalar-v1",
  chunks: [
    { first_id: "a", last_id: "m", key: CHUNK_A, byte_length: 185, row_count: 2 },
    { first_id: "n", last_id: "z", key: CHUNK_B, byte_length: 183, row_count: 2 },
  ],
} as const);

const PUBLISH_MANIFEST_B_BODY = deepFreeze({
  schema_version: 2,
  collection: "items",
  log_seq_start: 120,
  incarnation: INCARNATION_B,
  collation: "utf8-scalar-v1",
  chunks: [{ first_id: "a", last_id: "z", key: CHUNK_C, byte_length: 188, row_count: 2 }],
} as const);

const PUBLISH_CURRENT_A_BODY = deepFreeze({
  ...CURRENT_BEFORE_FENCE,
  snapshot: MANIFEST_A,
  log_seq_start: 120,
  snapshot_bytes: 368,
  snapshot_rows: 4,
} as const);

const PUBLISH_CURRENT_B_BODY = deepFreeze({
  ...CURRENT_BEFORE_FENCE,
  snapshot: MANIFEST_B,
  log_seq_start: 120,
  snapshot_bytes: 188,
  snapshot_rows: 2,
} as const);

export const PUBLISHER_EXPECTED_BODIES = deepFreeze({
  "chunk-a1": PUBLISH_CHUNK_A1_BODY,
  "chunk-a2": PUBLISH_CHUNK_A2_BODY,
  "chunk-b": PUBLISH_CHUNK_B_BODY,
  "manifest-a": PUBLISH_MANIFEST_A_BODY,
  "manifest-b": PUBLISH_MANIFEST_B_BODY,
  "current-a": PUBLISH_CURRENT_A_BODY,
  "current-b": PUBLISH_CURRENT_B_BODY,
  "current-before-publish": CURRENT_BEFORE_FENCE,
  "current-after-winner": {
    ...CURRENT_BEFORE_FENCE,
    snapshot: WINNER_MANIFEST,
    log_seq_start: 110,
    snapshot_bytes: 700_000,
    snapshot_rows: 1_900,
  },
} as const);

const casWin = defineFixture({
  scenario: "cas-win",
  publisher_bodies: PUBLISHER_EXPECTED_BODIES,
  publication_attempts: [{ attempt_id: "publish-1", incarnation: INCARNATION_A }],
  steps: [
    {
      method: "get",
      key_class: "current",
      key: CURRENT_KEY,
      result_etag: '"head-before-publish"',
      outcome: "ok",
      attempt_id: "publish-1",
    },
    {
      method: "get",
      key_class: "manifest",
      key: CAPTURED_MANIFEST,
      outcome: "ok",
      attempt_id: "publish-1",
    },
    {
      method: "put",
      key_class: "chunk",
      key: CHUNK_A,
      incarnation: INCARNATION_A,
      condition: "if-none-match",
      if_none_match: "*",
      put_sha256: PUBLISH_CHUNK_A1_SHA256,
      put_body_id: "chunk-a1",
      outcome: "ok",
      attempt_id: "publish-1",
    },
    {
      method: "put",
      key_class: "chunk",
      key: CHUNK_B,
      incarnation: INCARNATION_A,
      condition: "if-none-match",
      if_none_match: "*",
      put_sha256: PUBLISH_CHUNK_A2_SHA256,
      put_body_id: "chunk-a2",
      outcome: "ok",
      attempt_id: "publish-1",
    },
    {
      method: "put",
      key_class: "manifest",
      key: MANIFEST_A,
      incarnation: INCARNATION_A,
      condition: "if-none-match",
      if_none_match: "*",
      put_sha256: PUBLISH_MANIFEST_A_SHA256,
      put_body_id: "manifest-a",
      outcome: "ok",
      attempt_id: "publish-1",
    },
    {
      method: "put",
      key_class: "current",
      key: CURRENT_KEY,
      condition: "if-match",
      if_match: '"head-before-publish"',
      put_sha256: PUBLISH_CURRENT_A_SHA256,
      put_body_id: "current-a",
      outcome: "ok",
      attempt_id: "publish-1",
    },
  ],
} as const);

const casLoss = defineFixture({
  scenario: "cas-loss",
  publisher_bodies: PUBLISHER_EXPECTED_BODIES,
  publication_attempts: [
    { attempt_id: "publish-lost", incarnation: INCARNATION_A },
    { attempt_id: "publish-restarted", incarnation: INCARNATION_B },
  ],
  steps: [
    {
      method: "get",
      key_class: "current",
      key: CURRENT_KEY,
      result_etag: '"head-before-publish"',
      outcome: "ok",
      attempt_id: "publish-lost",
    },
    {
      method: "get",
      key_class: "manifest",
      key: CAPTURED_MANIFEST,
      outcome: "ok",
      attempt_id: "publish-lost",
    },
    {
      method: "put",
      key_class: "chunk",
      key: CHUNK_A,
      incarnation: INCARNATION_A,
      condition: "if-none-match",
      if_none_match: "*",
      put_sha256: PUBLISH_CHUNK_A1_SHA256,
      put_body_id: "chunk-a1",
      outcome: "ok",
      attempt_id: "publish-lost",
    },
    {
      method: "put",
      key_class: "manifest",
      key: MANIFEST_A,
      incarnation: INCARNATION_A,
      condition: "if-none-match",
      if_none_match: "*",
      put_sha256: PUBLISH_MANIFEST_A_SHA256,
      put_body_id: "manifest-a",
      outcome: "ok",
      attempt_id: "publish-lost",
    },
    {
      method: "put",
      key_class: "current",
      key: CURRENT_KEY,
      condition: "if-match",
      if_match: '"head-before-publish"',
      put_sha256: PUBLISH_CURRENT_A_SHA256,
      put_body_id: "current-a",
      outcome: "conflict",
      attempt_id: "publish-lost",
    },
    {
      method: "get",
      key_class: "current",
      key: CURRENT_KEY,
      result_etag: '"head-after-winner"',
      outcome: "ok",
      attempt_id: "publish-restarted",
    },
    {
      method: "get",
      key_class: "manifest",
      key: WINNER_MANIFEST,
      outcome: "ok",
      attempt_id: "publish-restarted",
    },
    {
      method: "put",
      key_class: "chunk",
      key: CHUNK_C,
      incarnation: INCARNATION_B,
      condition: "if-none-match",
      if_none_match: "*",
      put_sha256: PUBLISH_CHUNK_B_SHA256,
      put_body_id: "chunk-b",
      outcome: "ok",
      attempt_id: "publish-restarted",
    },
    {
      method: "put",
      key_class: "manifest",
      key: MANIFEST_B,
      incarnation: INCARNATION_B,
      condition: "if-none-match",
      if_none_match: "*",
      put_sha256: PUBLISH_MANIFEST_B_SHA256,
      put_body_id: "manifest-b",
      outcome: "ok",
      attempt_id: "publish-restarted",
    },
    {
      method: "put",
      key_class: "current",
      key: CURRENT_KEY,
      condition: "if-match",
      if_match: '"head-after-winner"',
      put_sha256: PUBLISH_CURRENT_B_SHA256,
      put_body_id: "current-b",
      outcome: "ok",
      attempt_id: "publish-restarted",
    },
  ],
} as const);

const storageRetry = defineFixture({
  scenario: "storage-retry",
  publisher_bodies: PUBLISHER_EXPECTED_BODIES,
  publication_attempts: [{ attempt_id: "publish-retry", incarnation: INCARNATION_A }],
  steps: [
    {
      method: "get",
      key_class: "current",
      key: CURRENT_KEY,
      result_etag: '"head-before-publish"',
      outcome: "ok",
      attempt_id: "publish-retry",
    },
    {
      method: "get",
      key_class: "manifest",
      key: CAPTURED_MANIFEST,
      outcome: "ok",
      attempt_id: "publish-retry",
    },
    {
      method: "put",
      key_class: "chunk",
      key: CHUNK_A,
      incarnation: INCARNATION_A,
      condition: "if-none-match",
      if_none_match: "*",
      put_sha256: PUBLISH_CHUNK_A1_SHA256,
      put_body_id: "chunk-a1",
      outcome: "error",
      attempt_id: "publish-retry",
    },
    {
      method: "put",
      key_class: "chunk",
      key: CHUNK_A,
      incarnation: INCARNATION_A,
      condition: "if-none-match",
      if_none_match: "*",
      put_sha256: PUBLISH_CHUNK_A1_SHA256,
      put_body_id: "chunk-a1",
      outcome: "ok",
      attempt_id: "publish-retry",
    },
    {
      method: "put",
      key_class: "manifest",
      key: MANIFEST_A,
      incarnation: INCARNATION_A,
      condition: "if-none-match",
      if_none_match: "*",
      put_sha256: PUBLISH_MANIFEST_A_SHA256,
      put_body_id: "manifest-a",
      outcome: "ok",
      attempt_id: "publish-retry",
    },
    {
      method: "put",
      key_class: "current",
      key: CURRENT_KEY,
      condition: "if-match",
      if_match: '"head-before-publish"',
      put_sha256: PUBLISH_CURRENT_A_SHA256,
      put_body_id: "current-a",
      outcome: "ok",
      attempt_id: "publish-retry",
    },
  ],
} as const);

const orphanMark = defineFixture({
  scenario: "orphan-mark",
  delete_authorized: false,
  steps: [
    {
      method: "list",
      key_class: "artifact-prefix",
      key: `${COLLECTION_PREFIX}/_v2/snapshot/chunks/`,
      max_keys: ARTIFACT_LIST_PAGE_SIZE,
      outcome: "ok",
    },
    {
      method: "get",
      key_class: "current",
      key: CURRENT_KEY,
      result_etag: '"head-epoch-7"',
      outcome: "ok",
    },
    { method: "get", key_class: "manifest", key: CAPTURED_MANIFEST, outcome: "ok" },
  ],
} as const);

const artifactFenceWin = defineFixture({
  scenario: "artifact-fence-win",
  captured_artifact_gc_epoch: 7,
  delete_authorized: true,
  delete_authority: FENCE_WIN_AUTHORITY,
  steps: [
    {
      method: "get",
      key_class: "current",
      key: CURRENT_KEY,
      result_etag: '"head-epoch-7"',
      outcome: "ok",
    },
    { method: "get", key_class: "manifest", key: CAPTURED_MANIFEST, outcome: "ok" },
    {
      method: "put",
      key_class: "current",
      key: CURRENT_KEY,
      condition: "if-match",
      if_match: '"head-epoch-7"',
      put_sha256: CURRENT_AFTER_FENCE_SHA256,
      result_etag: '"head-epoch-8"',
      outcome: "ok",
    },
    {
      method: "put",
      key_class: "gc-pending",
      key: PENDING_KEY,
      condition: "if-match",
      if_match: '"pending-before-fence"',
      put_sha256: PENDING_AUTHORITY_8_SHA256,
      result_etag: '"pending-authority-8"',
      outcome: "ok",
    },
    { method: "delete", key_class: "chunk", key: ORPHAN_CHUNK, outcome: "ok" },
    { method: "delete", key_class: "manifest", key: ORPHAN_MANIFEST, outcome: "ok" },
    {
      method: "put",
      key_class: "gc-pending",
      key: PENDING_KEY,
      condition: "if-match",
      if_match: '"pending-authority-8"',
      put_sha256: PENDING_COMPLETION_SHA256,
      result_etag: '"pending-complete-8"',
      outcome: "ok",
    },
  ],
} as const);

const artifactFenceConflict = defineFixture({
  scenario: "artifact-fence-conflict",
  captured_artifact_gc_epoch: 7,
  delete_authorized: false,
  steps: [
    {
      method: "get",
      key_class: "current",
      key: CURRENT_KEY,
      result_etag: '"head-epoch-7"',
      outcome: "ok",
    },
    { method: "get", key_class: "manifest", key: CAPTURED_MANIFEST, outcome: "ok" },
    {
      method: "put",
      key_class: "current",
      key: CURRENT_KEY,
      condition: "if-match",
      if_match: '"head-epoch-7"',
      put_sha256: CURRENT_AFTER_FENCE_SHA256,
      outcome: "conflict",
    },
    {
      method: "get",
      key_class: "current",
      key: CURRENT_KEY,
      result_etag: '"head-after-publisher"',
      outcome: "ok",
    },
    { method: "get", key_class: "manifest", key: WINNER_MANIFEST, outcome: "ok" },
  ],
} as const);

const artifactFenceResume = defineFixture({
  scenario: "artifact-fence-resume",
  captured_artifact_gc_epoch: 8,
  delete_authorized: true,
  resumed_from_authority: RESUMED_FROM_AUTHORITY,
  delete_authority: RESUME_DELETE_AUTHORITY,
  steps: [
    {
      method: "get",
      key_class: "gc-pending",
      key: PENDING_KEY,
      result_etag: '"pending-authority-8"',
      outcome: "ok",
    },
    {
      method: "get",
      key_class: "current",
      key: CURRENT_KEY,
      result_etag: '"head-epoch-8"',
      outcome: "ok",
    },
    { method: "get", key_class: "manifest", key: CAPTURED_MANIFEST, outcome: "ok" },
    {
      method: "put",
      key_class: "current",
      key: CURRENT_KEY,
      condition: "if-match",
      if_match: '"head-epoch-8"',
      put_sha256: CURRENT_AFTER_RESUME_FENCE_SHA256,
      result_etag: '"head-epoch-9"',
      outcome: "ok",
    },
    {
      method: "put",
      key_class: "gc-pending",
      key: PENDING_KEY,
      condition: "if-match",
      if_match: '"pending-authority-8"',
      put_sha256: PENDING_AUTHORITY_9_SHA256,
      result_etag: '"pending-authority-9"',
      outcome: "ok",
    },
    { method: "delete", key_class: "manifest", key: ORPHAN_MANIFEST, outcome: "ok" },
    {
      method: "put",
      key_class: "gc-pending",
      key: PENDING_KEY,
      condition: "if-match",
      if_match: '"pending-authority-9"',
      put_sha256: PENDING_COMPLETION_SHA256,
      result_etag: '"pending-complete-9"',
      outcome: "ok",
    },
  ],
} as const);

const artifactFenceExhausted = defineFixture({
  scenario: "artifact-fence-exhausted",
  captured_artifact_gc_epoch: Number.MAX_SAFE_INTEGER,
  delete_authorized: false,
  steps: [
    { method: "get", key_class: "current", key: CURRENT_KEY, outcome: "ok" },
    { method: "get", key_class: "manifest", key: CAPTURED_MANIFEST, outcome: "ok" },
  ],
} as const);

const boundedListPage = defineFixture({
  scenario: "bounded-list-page",
  delete_authorized: false,
  steps: [
    {
      method: "list",
      key_class: "artifact-prefix",
      key: `${COLLECTION_PREFIX}/_v2/snapshot/chunks/`,
      max_keys: ARTIFACT_LIST_PAGE_SIZE,
      outcome: "ok",
    },
    {
      method: "list",
      key_class: "artifact-prefix",
      key: `${COLLECTION_PREFIX}/_v2/snapshot/manifests/`,
      max_keys: ARTIFACT_LIST_PAGE_SIZE,
      outcome: "ok",
    },
  ],
} as const);

/** Independent expected journals; no production publisher or GC code is imported. */
export const EXPECTED_WORKLOAD_CEILING_JOURNALS = deepFreeze({
  "cas-win": casWin,
  "cas-loss": casLoss,
  "storage-retry": storageRetry,
  "orphan-mark": orphanMark,
  "artifact-fence-win": artifactFenceWin,
  "artifact-fence-conflict": artifactFenceConflict,
  "artifact-fence-resume": artifactFenceResume,
  "artifact-fence-exhausted": artifactFenceExhausted,
  "bounded-list-page": boundedListPage,
} as const satisfies Record<ChunkedStorageScenario, unknown>);
