/**
 * Format constants of the prototype tree. Unlike `TreeLayout`
 * (`./layout.ts`), no override can change these: they fix what a reader
 * accepts, so a test layout can never widen the decoder.
 *
 * The namespace segment and format tag are prototype-only values. The
 * real versioned namespace (docs/adr/003-layout-versioning-cordon.md) is
 * chosen when the format is adopted.
 */

/** Namespace segment under the collection prefix that holds every tree object. */
export const TREE_NS = "_v99";

/** The `format` tag of every node body. */
export const TREE_FORMAT = "baerly-tree-node-proto";

/** The `schema_version` of every node body. */
export const TREE_NODE_SCHEMA_VERSION = 1;

/**
 * Domain prefix of the chunk hash's HMAC message, used for
 * content-defined chunking. It separates chunk hashes from every other
 * keyed hash in the system. The version suffix names the keyed
 * construction, so a different message layout must take a different
 * domain.
 */
export const TREE_CHUNK_DOMAIN = "baerly-tree-chunk-v2";

/**
 * Length of a collection's chunk salt, the HMAC key of the chunk hash.
 * The head stores it as 32 lowercase hex characters.
 */
export const TREE_CHUNK_SALT_BYTES = 16;

/**
 * Largest valid node `level` (leaves are level 0). With a branch fanout
 * minimum of 2 every level is strictly smaller than the one below it, so
 * a tree of 2^53 rows stays far below this.
 */
export const TREE_MAX_LEVEL = 16;

/** Most child entries one branch may hold. */
export const BRANCH_MAX_ENTRIES = 256;

/**
 * Decoder ceiling on a branch body, in body bytes. It covers
 * {@link BRANCH_MAX_ENTRIES} entries of at most 1,211 bytes each (two
 * 256-byte IDs with every byte escaped, plus counts and refs) and the
 * envelope.
 */
export const BRANCH_MAX_BODY_BYTES = 524_288;

/**
 * Decoder ceiling on any node body, in body bytes, checked before the
 * node's kind is known. A format constant rather than a layout field, so
 * no layout override can change what a reader accepts.
 *
 * Every leaf the builder emits fits with slack. The largest envelope is
 * 721 bytes (a 256-byte collection name fully escaped, safe-integer
 * totals), so a leaf holding one isolated document is at most
 * `MAX_DOCUMENT_BYTES` + 721 bytes. Any other leaf holds less than 1 MiB of
 * document bytes plus fewer than one separator per 11 of them, so every
 * leaf body is at most 1,144,622 bytes.
 */
export const LEAF_MAX_BODY_BYTES = 2_097_152;

/**
 * Canonical bytes of the smallest valid document, `{"_id":"x"}`. Every
 * subtree therefore holds at least this many document bytes per row.
 */
export const MIN_DOCUMENT_BYTES = 11;
