/**
 * Published chunk salts for pinned tree vectors. Test-only: production
 * mints every collection's salt from a CSPRNG, so these live outside
 * `packages/` where no shipped code can import them.
 */
import { importChunkKey } from "../../packages/server/src/tree/chunk.ts";

/** The salt every pinned chunk hash and shape vector uses, as stored in a head. */
export const TREE_TEST_CHUNK_SALT = "000102030405060708090a0b0c0d0e0f";

/** A second salt, for vectors showing the salt is an input of the tree. */
export const TREE_SECOND_TEST_CHUNK_SALT = "0f0e0d0c0b0a09080706050403020100";

/** The chunk key of {@link TREE_TEST_CHUNK_SALT}. */
export const testChunkKey = () => importChunkKey(Uint8Array.fromHex(TREE_TEST_CHUNK_SALT));
