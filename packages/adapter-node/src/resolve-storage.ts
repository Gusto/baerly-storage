import { BaerlyError, isDeployedEnv, type Storage } from "@baerly/protocol";
import { localFsStorage } from "./local-fs-storage.ts";
import { r2Storage, s3Storage } from "./storage-factories.ts";

/** Result of {@link resolveStorageFromEnv}. */
export interface ResolvedStorage {
  readonly storage: Storage;
  /** Human-readable backend label for a startup log line. */
  readonly label: string;
}

/**
 * Choose a Node `Storage` backend from environment variables, in priority
 * order:
 *   1. `R2_ACCOUNT_ID` set → Cloudflare R2 (S3-compat endpoint)
 *   2. `BUCKET` set        → AWS S3
 *   3. neither, local dev  → `localFsStorage` (zero credentials)
 *   4. neither, deployed   → throw
 *
 * This is the safe default the example scaffolds use, exported so apps
 * don't hand-roll their own selector and reintroduce the silent
 * in-memory / local-fs fallback this library exists to prevent. There is
 * deliberately **no** fallback to a non-durable store in a deployment:
 * local-fs is single-process with no cross-process CAS and no crash
 * durability, and in-memory storage loses all data on restart, so a
 * deployed environment with no bucket fails loud instead.
 *
 * `env` is injectable for testing; it defaults to `process.env`.
 *
 * @throws BaerlyError `InvalidConfig` when {@link isDeployedEnv} is true
 * and no bucket is configured, or when a configured bucket is missing its
 * credentials.
 *
 * @example
 * ```ts
 * import { baerlyNode, resolveStorageFromEnv } from "@gusto/baerly-storage/node";
 * import config from "./baerly.config.ts";
 *
 * const { storage, label } = resolveStorageFromEnv();
 * console.log(`[baerly] storage=${label}`);
 * await baerlyNode({ config, storage }).listen(Number(process.env["PORT"] ?? 8080));
 * ```
 */
export const resolveStorageFromEnv = (
  env: Record<string, string | undefined> = process.env,
): ResolvedStorage => {
  // An env var set to "" is treated as unset for backend selection, so an
  // exported-but-empty BUCKET / R2_ACCOUNT_ID falls through to the local-dev
  // fallback (or the deployment fail-closed) rather than entering a branch
  // and then throwing a confusing "missing required env var" for a var that
  // is, technically, set.
  const isSet = (name: string): boolean => (env[name] ?? "") !== "";
  const reqEnv = (name: string): string => {
    const v = env[name];
    if (v === undefined || v === "") {
      throw new BaerlyError("InvalidConfig", `Missing required env var: ${name}`);
    }
    return v;
  };

  if (isSet("R2_ACCOUNT_ID")) {
    return {
      storage: r2Storage({
        accountId: reqEnv("R2_ACCOUNT_ID"),
        bucket: reqEnv("BUCKET"),
        credentials: {
          accessKeyId: reqEnv("AWS_ACCESS_KEY_ID"),
          secretAccessKey: reqEnv("AWS_SECRET_ACCESS_KEY"),
        },
      }),
      label: `r2 (bucket=${env["BUCKET"]})`,
    };
  }
  if (isSet("BUCKET")) {
    return {
      storage: s3Storage({
        region: env["AWS_REGION"] ?? "us-east-1",
        bucket: reqEnv("BUCKET"),
        credentials: {
          accessKeyId: reqEnv("AWS_ACCESS_KEY_ID"),
          secretAccessKey: reqEnv("AWS_SECRET_ACCESS_KEY"),
        },
      }),
      label: `s3 (bucket=${env["BUCKET"]})`,
    };
  }
  if (!isDeployedEnv(env)) {
    return {
      storage: localFsStorage(),
      label: `local-fs (${env["BAERLY_DATA_DIR"] ?? "./.baerly-data"}) — local dev only, not a production store`,
    };
  }
  throw new BaerlyError(
    "InvalidConfig",
    [
      "[baerly] Refusing to start: no durable storage configured in a deployed environment.",
      "Local filesystem storage is a local-dev convenience only — single-process, with no",
      "cross-process CAS and no crash durability — so it is never used in production.",
      "Configure a real bucket:",
      "  • AWS S3:        BUCKET + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ optional AWS_REGION)",
      "  • Cloudflare R2: R2_ACCOUNT_ID + BUCKET + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY",
      "Self-hosting without a cloud bucket? Run MinIO on the box for real S3 semantics, or",
      "use SQLite + Litestream for a single-instance app.",
    ].join("\n"),
  );
};
