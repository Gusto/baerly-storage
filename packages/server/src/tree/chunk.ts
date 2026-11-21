/**
 * Content-defined chunking primitives of the prototype tree: the chunk
 * hash and the per-entry cut predicates, and nothing else. The chunking
 * loops that apply them, with large-document isolation and the branch
 * fanout counting, live with the builder.
 *
 * Cut inputs are the level, the `_id`, byte counts and the collection's
 * chunk salt only, never an attempt identity, the collection name or the
 * host, so the tree is a pure function of the row set, the layout and
 * the salt. The hash is keyed by the salt (HMAC-SHA-256), so a caller
 * who cannot read the bucket cannot grind IDs whose hashes never cut.
 * Pure code takes the salt as an argument; it is minted with the head.
 *
 * The salt is confidential: no error message here names its value.
 */
import { BaerlyError } from "@baerly/protocol";
import { assertSnapshotDocId } from "../snapshot-doc-id.ts";
import { TREE_CHUNK_DOMAIN, TREE_CHUNK_SALT_BYTES, TREE_MAX_LEVEL } from "./constants.ts";
import type { TreeLayout } from "./layout.ts";

const utf8 = new TextEncoder();
const DOMAIN_BYTES = utf8.encode(TREE_CHUNK_DOMAIN);

/** 2^32: the hash range, and the scale of every cut threshold. */
const HASH_RANGE = 4_294_967_296;

/**
 * The HMAC message of the chunk hash:
 * `TREE_CHUNK_DOMAIN ‖ 0x00 ‖ byte(level) ‖ UTF-8(id)`. Level 0 is the
 * leaf level; level ℓ ≥ 1 is the branch level being chunked.
 *
 * @throws BaerlyError code="Internal" — `level` is outside
 *   0..TREE_MAX_LEVEL or `id` is outside the document-ID domain. Callers
 *   validate stored IDs first, so either is a bug.
 */
export const chunkPreimage = (level: number, id: string): Uint8Array<ArrayBuffer> => {
  if (!Number.isSafeInteger(level) || level < 0 || level > TREE_MAX_LEVEL) {
    throw new BaerlyError("Internal", `chunk hash: level ${level} is outside 0..${TREE_MAX_LEVEL}`);
  }
  try {
    assertSnapshotDocId(id);
  } catch (error) {
    throw new BaerlyError(
      "Internal",
      `chunk hash: _id ${JSON.stringify(id)} is outside the document-ID domain`,
      { cause: error },
    );
  }
  const idBytes = utf8.encode(id);
  const preimage = new Uint8Array(DOMAIN_BYTES.byteLength + 2 + idBytes.byteLength);
  preimage.set(DOMAIN_BYTES, 0);
  preimage[DOMAIN_BYTES.byteLength] = 0;
  preimage[DOMAIN_BYTES.byteLength + 1] = level;
  preimage.set(idBytes, DOMAIN_BYTES.byteLength + 2);
  return preimage;
};

/**
 * A collection's chunk salt, imported once as an HMAC key. It is an
 * opaque handle: the object holds no salt bytes, so logging or
 * serializing it reveals nothing.
 */
export interface ChunkKey {
  readonly kind: "tree-chunk-key";
}

const HMAC_KEYS = new WeakMap<ChunkKey, CryptoKey>();
/** The SHA-256 of each handle's salt: it identifies the salt without holding it. */
const SALT_DIGESTS = new WeakMap<ChunkKey, Uint8Array>();

const saltDigest = async (salt: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(salt)));

/**
 * Import the 16-byte chunk salt `salt` as the key of {@link chunkHash}.
 * Import once per collection per invocation and reuse the handle for
 * every hash. The bytes are copied, so changing `salt` afterwards has no
 * effect.
 *
 * @throws BaerlyError code="Internal" — `salt` is not a `Uint8Array` of
 *   exactly `TREE_CHUNK_SALT_BYTES` bytes. The head validates the stored
 *   salt first, so this is a bug. The message never contains the value.
 */
export const importChunkKey = async (salt: Uint8Array): Promise<ChunkKey> => {
  if (!(salt instanceof Uint8Array)) {
    throw new BaerlyError("Internal", "chunk hash: the chunk salt is not a Uint8Array");
  }
  if (salt.byteLength !== TREE_CHUNK_SALT_BYTES) {
    throw new BaerlyError(
      "Internal",
      `chunk hash: the chunk salt is ${salt.byteLength} bytes, not ${TREE_CHUNK_SALT_BYTES}`,
    );
  }
  const bytes = Uint8Array.from(salt);
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const handle: ChunkKey = Object.freeze({ kind: "tree-chunk-key" });
  HMAC_KEYS.set(handle, key);
  SALT_DIGESTS.set(handle, await saltDigest(bytes));
  return handle;
};

/**
 * Whether `key` was imported from the salt `salt`. A handle not made by
 * {@link importChunkKey} matches no salt.
 */
export const chunkKeyIsOf = async (key: ChunkKey, salt: Uint8Array): Promise<boolean> => {
  const digest = SALT_DIGESTS.get(key);
  if (digest === undefined) {
    return false;
  }
  const other = await saltDigest(salt);
  return other.byteLength === digest.byteLength && other.every((byte, i) => byte === digest[i]);
};

/**
 * The chunk hash `h(level, id)` under the salt behind `key`: the first
 * four bytes of `HMAC-SHA-256(salt, chunkPreimage(level, id))`, as a
 * big-endian unsigned 32-bit integer.
 *
 * @throws BaerlyError code="Internal" — `key` did not come from
 *   {@link importChunkKey}, or as for {@link chunkPreimage}.
 */
export const chunkHash = async (key: ChunkKey, level: number, id: string): Promise<number> => {
  const hmacKey = HMAC_KEYS.get(key);
  if (hmacKey === undefined) {
    throw new BaerlyError("Internal", "chunk hash: the key was not made by importChunkKey");
  }
  const mac = await crypto.subtle.sign("HMAC", hmacKey, chunkPreimage(level, id));
  return new DataView(mac).getUint32(0, false);
};

/**
 * Whether a leaf is cut after the entry that took its document bytes
 * from `before` to `after`, given that entry's hash `hash`. The rule is
 * one formula:
 *
 * ```text
 * a = max(before, leafMinBytes)
 * cut = hash × (leafMaxBytes − a) < 2^32 × (after − a)
 * ```
 *
 * That is the conditional probability of a cut size drawn uniformly
 * from `(leafMinBytes, leafMaxBytes]`, given no cut by `before`, so the
 * mean leaf is near `leafTargetBytes` at any document granularity. The
 * two early returns below are consequences of the formula, not further
 * rules: at `after ≤ leafMinBytes` the right side is at most 0, so it
 * never cuts; at `after ≥ leafMaxBytes` it cuts for every hash (the
 * forced cut, after the crossing entry).
 *
 * Layout validation keeps `leafMaxBytes − leafMinBytes ≤ 2^20`, so both
 * products stay below 2^52 and are exact.
 */
export const cutLeaf = (
  before: number,
  after: number,
  hash: number,
  layout: Pick<TreeLayout, "leafMinBytes" | "leafMaxBytes">,
): boolean => {
  if (after >= layout.leafMaxBytes) {
    return true;
  }
  if (after <= layout.leafMinBytes) {
    return false;
  }
  const from = Math.max(before, layout.leafMinBytes);
  return hash * (layout.leafMaxBytes - from) < HASH_RANGE * (after - from);
};

/**
 * Whether a branch entry's hash cuts its level once the node has
 * `branchFanoutMin` entries: `hash < 2^32 / branchFanoutTarget`, a
 * probability of `1 / branchFanoutTarget` per entry. The forced cut at
 * `branchFanoutMax` and the minimum are the builder's to apply.
 */
export const branchHashCuts = (
  hash: number,
  layout: Pick<TreeLayout, "branchFanoutTarget">,
): boolean => hash < HASH_RANGE / layout.branchFanoutTarget;
