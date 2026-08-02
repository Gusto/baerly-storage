import { resolve } from "node:path";
import type { Storage } from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev/local-fs";

export interface LocalFsStorageFactoryOptions {
  /**
   * Root data directory. Resolution order: this option →
   * `$BAERLY_DATA_DIR` → `<cwd>/.baerly-data`.
   */
  readonly dataDir?: string;
}

/**
 * Zero-config local `Storage` for single-node dev / self-hosted runs.
 * Persists to the filesystem (content-addressed, atomic writes), so data
 * survives process restarts — unlike `MemoryStorage`, which is per-process
 * and lost on exit.
 *
 * NOT for multi-instance production: `LocalFsStorage`'s `ifMatch` CAS is
 * serialized within one process only, so a `current.json` CAS-advance is
 * not atomic against a second process on the same directory (see its class
 * JSDoc). Every call here returns a fresh instance, which is fine — the
 * lock is keyed by resolved root, so instances sharing a directory share
 * it. For horizontally-scaled deploys use `s3Storage` / `r2Storage`, whose
 * cross-process guarantee the no-lease maintenance fold relies on.
 *
 * @example
 * ```ts
 * import { baerlyNode, localFsStorage } from "@gusto/baerly-storage/node";
 * import config from "./baerly.config.ts";
 *
 * // Runs with zero credentials; persists to ./.baerly-data.
 * await baerlyNode({ config, storage: localFsStorage() }).listen(8080);
 * ```
 */
export const localFsStorage = (opts?: LocalFsStorageFactoryOptions): Storage =>
  new LocalFsStorage({
    root: opts?.dataDir ?? process.env["BAERLY_DATA_DIR"] ?? resolve(process.cwd(), ".baerly-data"),
  });
