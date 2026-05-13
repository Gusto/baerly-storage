/**
 * Server entry for {{appName}}. Wires `@baerly/adapter-node` with
 * production-shaped storage + verifier defaults.
 *
 * Storage: AWS S3 (override via `S3_ENDPOINT` for R2/Minio/GCS).
 * Verifier: JWKS-backed JWT when `JWKS_URL` is set; falls back
 * to shared secret for `pnpm dev` parity. Production deployments
 * should set `JWKS_URL` and remove the shared-secret branch.
 * Maintenance: hourly `runMaintenanceTick` on `setInterval`.
 */
import { createServer } from "node:http";
import { DOMParser } from "@xmldom/xmldom";
import { AwsClient } from "aws4fetch";
import { createListener, runMaintenanceTick, S3HttpStorage } from "@baerly/adapter-node";
import { bearerJwt, sharedSecret } from "@baerly/server/auth";
import type { FriendlyLogLevel } from "@baerly/server";
import type { Verifier } from "@baerly/protocol";

const reqEnv = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`Missing required env var: ${name}`);
  return v;
};

const APP = "{{appName}}";
const TENANT = process.env.TENANT ?? "{{tenant}}";
const PORT = Number(process.env.PORT ?? "8080");

const aws = new AwsClient({
  accessKeyId: reqEnv("AWS_ACCESS_KEY_ID"),
  secretAccessKey: reqEnv("AWS_SECRET_ACCESS_KEY"),
  region: process.env.AWS_REGION ?? "us-east-1",
  service: "s3",
});

const storage = new S3HttpStorage({
  endpoint:
    process.env.S3_ENDPOINT ?? `https://s3.${process.env.AWS_REGION ?? "us-east-1"}.amazonaws.com`,
  bucket: reqEnv("BUCKET"),
  xmlParser: new DOMParser(),
  sign: (req) => aws.sign(req),
});

const verifier: Verifier =
  process.env.JWKS_URL !== undefined
    ? bearerJwt({
        jwks: process.env.JWKS_URL,
        issuer: reqEnv("JWT_ISSUER"),
        audience: reqEnv("JWT_AUDIENCE"),
      })
    : sharedSecret({ secret: reqEnv("SHARED_SECRET"), tenantPrefix: TENANT });

// Phase-9 observability — one canonical JSON line per request /
// maintenance run on stdout. `LOG_LEVEL` toggles between
// `debug | info | warn | error` (default `info`); `LOG_SAMPLE` is
// the head-based sample rate for successful requests in `[0, 1]`
// (default `0.1` — errors are always kept; maintenance always emits).
// Pass `observability: undefined` (or omit the field) to skip
// LogTape configuration entirely; the kernel's recorder pipe still
// runs and the `metrics` option remains the authoritative sink.
// See `docs/observability.md` for sink wiring (OTel, Datadog,
// Workers Analytics Engine) and the canonical-line field reference.
// For a local dev landing page, pass:
//   dev: { app: APP, uiUrl: "http://localhost:5173" }
// — surfaces a small HTML page on `GET /` so a curious browser
// hit on the API root sees an explanation instead of a JSON 404.
// Leave unset in production.
const listener = createListener({
  app: APP,
  storage,
  verifier,
  observability: {
    level: process.env.LOG_LEVEL as FriendlyLogLevel | undefined,
    sampleRate: process.env.LOG_SAMPLE !== undefined ? Number(process.env.LOG_SAMPLE) : 0.1,
  },
});
const server = createServer(listener);

server.listen(PORT, () => console.log(`{{appName}} listening on :${PORT}`));

// Maintenance loop — hourly. Per-collection currentJsonKey shape
// matches `Db.create({ app, tenant })`'s manifest prefix.
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
if (process.env.MAINTENANCE_KEY !== undefined) {
  const maintenanceKey = process.env.MAINTENANCE_KEY;
  setInterval(() => {
    void runMaintenanceTick({
      storage,
      currentJsonKey: maintenanceKey,
    }).catch((e: unknown) => {
      console.error("maintenance tick failed", e);
    });
  }, MAINTENANCE_INTERVAL_MS).unref();
}

// Graceful shutdown — SIGTERM from docker stop / k8s preStop.
const shutdown = (sig: NodeJS.Signals): void => {
  console.log(`Received ${sig}; closing server`);
  server.close((err) => {
    if (err) {
      console.error("server.close error", err);
      process.exit(1);
    }
    process.exit(0);
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
