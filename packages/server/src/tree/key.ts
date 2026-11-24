/**
 * Object keys of the prototype tree and the attempt identity they carry.
 *
 * Every node is a create-only object at
 * `<P>/_v99/n/<attempt>/<sha256>`, where `P` is the collection's
 * `current.json` key without `/current.json`. `attempt` is 32 lowercase
 * hex characters (128 bits) minted fresh for each publication attempt;
 * `sha256` is 64 lowercase hex characters, the SHA-256 of the exact
 * stored body.
 *
 * Every publication attempt also writes one create-only fold record at
 * `<P>/_v99/r/<floor16>/<attempt>/<sha256>`, where `floor16` is the
 * `log_seq_start` of the head the attempt captured as exactly 16 decimal
 * digits, zero-padded (every safe integer fits), and `sha256` is the
 * SHA-256 of the exact record body. A LIST of the record prefix returns
 * records by captured floor, then by attempt. `<P>/_v99/gc-pending.json`
 * is reserved for GC's state.
 *
 * The grammar is closed: no other hash, width, case, extension, version
 * segment or extra segment parses. Neither a record key nor the state
 * key starts with the node prefix, so GC, which deletes as a node only a
 * key that parses as one, never deletes either as a node.
 */
import { BaerlyError } from "@baerly/protocol";
import { assertKeyWithinLimit } from "../key-limit.ts";
import { assertPathSegment } from "../path-segment.ts";
import { TREE_NS } from "./constants.ts";

const ATTEMPT_PATTERN = /^[0-9a-f]{32}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const NODE_KEY_TAIL_PATTERN = /^[0-9a-f]{32}\/[0-9a-f]{64}$/;
const RECORD_KEY_TAIL_PATTERN = /^[0-9]{16}\/[0-9a-f]{32}\/[0-9a-f]{64}$/;
/** Decimal digits of a record key's floor: `Number.MAX_SAFE_INTEGER` has 16. */
const RECORD_FLOOR_DIGITS = 16;

/** Whether `value` is a well-formed attempt identity (32 lowercase hex). */
export const isTreeAttempt = (value: unknown): value is string =>
  typeof value === "string" && ATTEMPT_PATTERN.test(value);

/** Whether `value` is a well-formed node content hash (64 lowercase hex). */
export const isTreeSha256 = (value: unknown): value is string =>
  typeof value === "string" && SHA256_PATTERN.test(value);

/** The parts of a node key. */
export interface TreeNodeKeyParts {
  readonly attempt: string;
  readonly sha256: string;
}

/**
 * The collection name of prefix `P`: its last `/` segment. Node bodies
 * carry it, and a decoder always takes it from `P`, never from the body.
 *
 * @throws BaerlyError code="InvalidConfig" — the last segment is not a
 *   valid key segment (empty, reserved, too long, ...).
 */
export const collectionOfPrefix = (prefix: string): string => {
  const collection = prefix.slice(prefix.lastIndexOf("/") + 1);
  assertPathSegment(collection, "tree prefix collection");
  return collection;
};

/**
 * The key prefix every node of the collection at `prefix` sits under:
 * `<P>/_v99/n/`. A node key is this followed by `<attempt>/<sha256>`.
 */
export const treeNodeKeyPrefix = (prefix: string): string => `${prefix}/${TREE_NS}/n/`;

/**
 * The key of the node with this attempt and content hash under `prefix`.
 *
 * @throws BaerlyError code="Internal" — `attempt` or `sha256` is not
 *   well-formed (a caller bug: both come from tree code).
 * @throws BaerlyError code="InvalidConfig" — the assembled key exceeds
 *   the storage key ceiling.
 */
export const treeNodeKey = (prefix: string, attempt: string, sha256: string): string => {
  if (!isTreeAttempt(attempt)) {
    throw new BaerlyError(
      "Internal",
      `tree node key: malformed attempt ${JSON.stringify(attempt)}`,
    );
  }
  if (!isTreeSha256(sha256)) {
    throw new BaerlyError("Internal", `tree node key: malformed sha256 ${JSON.stringify(sha256)}`);
  }
  const key = `${treeNodeKeyPrefix(prefix)}${attempt}/${sha256}`;
  assertKeyWithinLimit(key);
  return key;
};

/**
 * Parse `key` as a node key under `prefix`, or return `null` if it is
 * anything else. Only an exact `<prefix>/_v99/n/<attempt>/<sha256>`
 * parses.
 */
export const parseTreeNodeKey = (prefix: string, key: string): TreeNodeKeyParts | null => {
  const head = treeNodeKeyPrefix(prefix);
  if (!key.startsWith(head)) {
    return null;
  }
  const tail = key.slice(head.length);
  if (!NODE_KEY_TAIL_PATTERN.test(tail)) {
    return null;
  }
  return { attempt: tail.slice(0, 32), sha256: tail.slice(33) };
};

/** The parts of a fold-record key. */
export interface TreeRecordKeyParts {
  /** The `log_seq_start` of the head the attempt captured. */
  readonly floor: number;
  readonly attempt: string;
  readonly sha256: string;
}

/**
 * The key prefix every fold record of the collection at `prefix` sits
 * under: `<P>/_v99/r/`. A record key is this followed by
 * `<floor16>/<attempt>/<sha256>`.
 */
export const treeRecordKeyPrefix = (prefix: string): string => `${prefix}/${TREE_NS}/r/`;

/**
 * The key of the fold record of the attempt `attempt` that captured a
 * head at `floor`, whose body hashes to `sha256`.
 *
 * @throws BaerlyError code="Internal" — `floor` is not a non-negative
 *   safe integer, or `attempt` or `sha256` is not well-formed (a caller
 *   bug: all three come from tree code).
 * @throws BaerlyError code="InvalidConfig" — the assembled key exceeds
 *   the storage key ceiling.
 */
export const treeRecordKey = (
  prefix: string,
  floor: number,
  attempt: string,
  sha256: string,
): string => {
  if (!Number.isSafeInteger(floor) || floor < 0) {
    throw new BaerlyError("Internal", `tree record key: malformed floor ${String(floor)}`);
  }
  if (!isTreeAttempt(attempt)) {
    throw new BaerlyError(
      "Internal",
      `tree record key: malformed attempt ${JSON.stringify(attempt)}`,
    );
  }
  if (!isTreeSha256(sha256)) {
    throw new BaerlyError(
      "Internal",
      `tree record key: malformed sha256 ${JSON.stringify(sha256)}`,
    );
  }
  const floor16 = String(floor).padStart(RECORD_FLOOR_DIGITS, "0");
  const key = `${treeRecordKeyPrefix(prefix)}${floor16}/${attempt}/${sha256}`;
  assertKeyWithinLimit(key);
  return key;
};

/**
 * Parse `key` as a fold-record key under `prefix`, or return `null` if
 * it is anything else. Only an exact
 * `<prefix>/_v99/r/<floor16>/<attempt>/<sha256>` with a safe-integer
 * floor parses.
 */
export const parseTreeRecordKey = (prefix: string, key: string): TreeRecordKeyParts | null => {
  const head = treeRecordKeyPrefix(prefix);
  if (!key.startsWith(head)) {
    return null;
  }
  const tail = key.slice(head.length);
  if (!RECORD_KEY_TAIL_PATTERN.test(tail)) {
    return null;
  }
  const floor = Number(tail.slice(0, RECORD_FLOOR_DIGITS));
  if (!Number.isSafeInteger(floor)) {
    return null;
  }
  const rest = tail.slice(RECORD_FLOOR_DIGITS + 1);
  return { floor, attempt: rest.slice(0, 32), sha256: rest.slice(33) };
};

/** The key of the collection's tree GC state: `<P>/_v99/gc-pending.json`. */
export const treeGcStateKey = (prefix: string): string => `${prefix}/${TREE_NS}/gc-pending.json`;

/**
 * Mint a fresh attempt identity: 128 random bits as lowercase hex. One
 * publication attempt (one capture of the head and its root, then at
 * most one head CAS) mints one value and uses it for every node it
 * creates. A retry, a restart or a concurrent attempt mints its own, so
 * two attempts never write the same key. Pure tree code takes the value
 * as an argument instead of calling this.
 */
export const mintTreeAttempt = (): string => crypto.getRandomValues(new Uint8Array(16)).toHex();
