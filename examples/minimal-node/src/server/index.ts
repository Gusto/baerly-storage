/**
 * Server entry for minimal-node. One call composes
 * `s3Storage` / `r2Storage`, an auth verifier, and a `node:http`
 * server with SIGTERM/SIGINT handling and (optionally) a
 * multi-collection maintenance loop.
 *
 * Storage: AWS S3 by default; set `R2_ACCOUNT_ID` to switch to
 * Cloudflare R2 via the S3-compat endpoint. For Minio or GCS, see
 * the `minioStorage` / `gcsStorage` factories in
 * `baerly-storage/node`.
 *
 * Verifier: JWKS-backed JWT when `JWKS_URL` is set (production);
 * `sharedSecret` otherwise (dev/CI). Production should set
 * `JWKS_URL` and remove the shared-secret branch.
 *
 * Maintenance: opt-in via `MAINTENANCE_COLLECTIONS` (comma-separated
 * collection slugs). Each tick runs one compact+GC pass per
 * (TENANT, collection) pair.
 */
import { baerlyNode, r2Storage, s3Storage } from "baerly-storage/node";
import { bearerJwt, sharedSecret } from "baerly-storage/auth";
import type { FriendlyLogLevel } from "baerly-storage/observability";
import type { Storage, Verifier } from "baerly-storage";

const reqEnv = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`Missing required env var: ${name}`);
  return v;
};

const APP = "minimal-node";
const TENANT = process.env["TENANT"] ?? "minimal-demo";

const storage: Storage =
  process.env["R2_ACCOUNT_ID"] !== undefined
    ? r2Storage({
        accountId: reqEnv("R2_ACCOUNT_ID"),
        bucket: reqEnv("BUCKET"),
        accessKeyId: reqEnv("AWS_ACCESS_KEY_ID"),
        secretAccessKey: reqEnv("AWS_SECRET_ACCESS_KEY"),
      })
    : s3Storage({
        region: process.env["AWS_REGION"] ?? "us-east-1",
        bucket: reqEnv("BUCKET"),
        accessKeyId: reqEnv("AWS_ACCESS_KEY_ID"),
        secretAccessKey: reqEnv("AWS_SECRET_ACCESS_KEY"),
      });

const verifier: Verifier =
  process.env["JWKS_URL"] !== undefined
    ? bearerJwt({
        jwks: process.env["JWKS_URL"],
        issuer: reqEnv("JWT_ISSUER"),
        audience: reqEnv("JWT_AUDIENCE"),
      })
    : sharedSecret({ secret: reqEnv("SHARED_SECRET"), tenantPrefix: TENANT });

const maintenance =
  process.env["MAINTENANCE_COLLECTIONS"] !== undefined
    ? {
        collections: process.env["MAINTENANCE_COLLECTIONS"].split(",")
          .map((c) => c.trim())
          .filter((c) => c.length > 0),
        tenants: [TENANT],
      }
    : undefined;

const PORT = Number(process.env["PORT"] ?? 8080);

await baerlyNode({
  app: APP,
  storage,
  verifier,
  webRoot: process.env["WEB_ROOT"] ?? "./dist/client",
  observability: {
    level: process.env["LOG_LEVEL"] as FriendlyLogLevel | undefined,
    sampleRate: process.env["LOG_SAMPLE"] !== undefined ? Number(process.env["LOG_SAMPLE"]) : 0.1,
  },
  ...(maintenance !== undefined && { maintenance }),
}).listen(PORT);

console.log(`minimal-node listening on :${PORT}`);
