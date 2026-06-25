/**
 * Storage resolution for the Node server entry, in priority order:
 *   1. R2_ACCOUNT_ID set → Cloudflare R2 (S3-compat endpoint)
 *   2. BUCKET set        → AWS S3
 *   3. neither, local dev → LocalFsStorage (zero credentials)
 *   4. neither, deployed  → throw. local-fs is a local-dev convenience
 *      only — single-process, no cross-process CAS, no crash-fsync — so
 *      it is never a production store (there is no opt-in).
 *
 * Extracted from the server entry so the deployment safety guard is one
 * tested unit instead of fragile copy-paste — see
 * `tests/integration/node-storage-resolution.test.ts`. Kept byte-identical
 * across the Node example scaffolds and fenced by a drift test in that file.
 * Edit it freely in your own app: this is your storage policy, not the
 * kernel's.
 */
import { localFsStorage, r2Storage, s3Storage } from "@gusto/baerly-storage/node";
import type { Storage } from "@gusto/baerly-storage";

export interface ResolvedStorage {
  readonly storage: Storage;
  /** Human-readable backend label for the startup log line. */
  readonly label: string;
}

// Heuristic for "this is a real deployment, not a laptop." Any one
// marker is enough; it decides whether a missing bucket should fail
// loud (deployment) or fall back to local-fs (local dev).
const PAAS_MARKERS = [
  "RAILWAY_ENVIRONMENT",
  "RENDER",
  "FLY_APP_NAME",
  "K_SERVICE", // Google Cloud Run
  "DYNO", // Heroku
  "KUBERNETES_SERVICE_HOST", // Kubernetes
  "ECS_CONTAINER_METADATA_URI_V4", // AWS ECS
];

/**
 * Choose the storage backend from environment variables. `env` is
 * injectable so the decision can be unit-tested; it defaults to
 * `process.env`.
 *
 * @throws when a deployment is detected with no bucket configured —
 * local-fs is never a production store, and there is no opt-in.
 */
export const resolveStorage = (
  env: Record<string, string | undefined> = process.env,
): ResolvedStorage => {
  const reqEnv = (name: string): string => {
    const v = env[name];
    if (v === undefined || v === "") {
      throw new Error(`Missing required env var: ${name}`);
    }
    return v;
  };

  const looksDeployed =
    env["NODE_ENV"] === "production" || PAAS_MARKERS.some((m) => (env[m] ?? "") !== "");

  if (env["R2_ACCOUNT_ID"] !== undefined) {
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
  if (env["BUCKET"] !== undefined) {
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
  if (!looksDeployed) {
    return {
      storage: localFsStorage(),
      label: `local-fs (${env["BAERLY_DATA_DIR"] ?? "./.baerly-data"}) — local dev only, not a production store`,
    };
  }
  throw new Error(
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
