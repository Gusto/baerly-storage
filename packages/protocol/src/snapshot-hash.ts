import { sha256Hex } from "./sha256.ts";

/**
 * SHA-256 of `bytes` as a 64-char lowercase hex string. Used to seal
 * snapshot filenames so a crashed mid-PUT can't produce a body that
 * readers consume as truth: the filename embeds the hash; readers
 * recompute on load and reject any mismatch as "file missing."
 *
 * Distinct from {@link versionFromContent} (truncated to 32 chars for
 * content keys) — snapshot bodies are larger and longer-lived;
 * 256-bit collision resistance matters here.
 */
export const snapshotHash = (bytes: Uint8Array): Promise<string> => sha256Hex(bytes);
