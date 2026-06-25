/**
 * Server entry for minimal-node. `baerlyNode(opts)` reads
 * `opts.config.auth` to choose its verifier — the scaffold ships
 * `auth: "none"`, so every request resolves to `config.tenant`
 * with no header check. See AGENTS.md "Going to production" for
 * the recipe to flip `auth` or wire a custom verifier.
 *
 * Storage: zero-config `LocalFsStorage` rooted at ./.baerly-data for
 * local development — no credentials. Set `BUCKET` (+ AWS creds) for AWS
 * S3, or `R2_ACCOUNT_ID` (+ creds) for Cloudflare R2. In a detected
 * deployment (NODE_ENV=production or a known PaaS) the server REFUSES to
 * start without a bucket — local-fs is a local-dev convenience only
 * (single-process, no cross-process CAS, no crash durability), never a
 * production store — so a missing/typo'd bucket fails loud instead of
 * silently losing data.
 */
import { baerlyNode, localFsStorage, r2Storage, s3Storage } from "@gusto/baerly-storage/node";
import type { Storage } from "@gusto/baerly-storage";
import config from "../../baerly.config.ts";

const reqEnv = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
};

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
const looksDeployed =
  process.env["NODE_ENV"] === "production" ||
  PAAS_MARKERS.some((m) => (process.env[m] ?? "") !== "");
// Storage resolution, in priority order:
//   1. R2_ACCOUNT_ID set → Cloudflare R2 (S3-compat endpoint)
//   2. BUCKET set        → AWS S3
//   3. neither, local dev → LocalFsStorage (zero credentials)
//   4. neither, deployed  → throw. local-fs is a local-dev convenience
//      only — single-process, no cross-process CAS, no crash-fsync — so
//      it is never a production store (there is no opt-in).
let storage: Storage;
let storageLabel: string;
if (process.env["R2_ACCOUNT_ID"] !== undefined) {
  storage = r2Storage({
    accountId: reqEnv("R2_ACCOUNT_ID"),
    bucket: reqEnv("BUCKET"),
    credentials: {
      accessKeyId: reqEnv("AWS_ACCESS_KEY_ID"),
      secretAccessKey: reqEnv("AWS_SECRET_ACCESS_KEY"),
    },
  });
  storageLabel = `r2 (bucket=${process.env["BUCKET"]})`;
} else if (process.env["BUCKET"] !== undefined) {
  storage = s3Storage({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    bucket: reqEnv("BUCKET"),
    credentials: {
      accessKeyId: reqEnv("AWS_ACCESS_KEY_ID"),
      secretAccessKey: reqEnv("AWS_SECRET_ACCESS_KEY"),
    },
  });
  storageLabel = `s3 (bucket=${process.env["BUCKET"]})`;
} else if (!looksDeployed) {
  storage = localFsStorage();
  storageLabel = `local-fs (${process.env["BAERLY_DATA_DIR"] ?? "./.baerly-data"}) — local dev only, not a production store`;
} else {
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
}

// Announce the effective backend so the chosen store (and any surprise
// local-fs fallback) is visible in the deploy logs, not a surprise.
console.log(`[baerly] storage=${storageLabel}`);

const PORT = Number(process.env["PORT"] ?? 8080);

// `webRoot` serves the Vite-built SPA from `dist/client/` (the
// `vite.config.ts` `build.outDir`) in production; `/v1/*` is handled
// by the kernel, everything else falls back to the SPA shell.
await baerlyNode({ config, storage, webRoot: "dist/client" }).listen(PORT);

console.log(`minimal-node listening on :${PORT}`);
