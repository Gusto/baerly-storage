/**
 * Server entry for react-node. `baerlyNode(opts)` reads
 * `opts.config.auth` to choose its verifier — the scaffold ships
 * `auth: "none"`, so every request resolves to `config.tenant`
 * with no header check. The schema declared in
 * `baerly.config.ts:collections.notes.schema` runs server-side on
 * every write. See AGENTS.md "Going to production" for the recipe
 * to flip `auth` or wire a custom verifier.
 *
 * Storage: zero-config `LocalFsStorage` rooted at ./.baerly-data by
 * default — runs with no credentials. Set `BUCKET` (+ AWS creds) for
 * AWS S3, or `R2_ACCOUNT_ID` (+ creds) for Cloudflare R2.
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

// Storage resolution, in priority order:
//   1. R2_ACCOUNT_ID set → Cloudflare R2 (S3-compat endpoint)
//   2. BUCKET set        → AWS S3
//   3. neither           → LocalFsStorage at ./.baerly-data
//                          (zero credentials; single-node only)
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
} else {
  storage = localFsStorage();
  storageLabel = "local-fs (./.baerly-data) — single-node, non-durable across redeploys";
}

// Announce the effective backend so a missing/typo'd bucket env (which
// silently selects local-fs) is visible in the deploy logs, not a surprise.
console.log(`[baerly] storage=${storageLabel}`);

const PORT = Number(process.env["PORT"] ?? 8080);

// `webRoot` serves the Vite-built SPA from `dist/client/` (the
// `vite.config.ts` `build.outDir`) in production; `/v1/*` is handled
// by the kernel, everything else falls back to the SPA shell.
await baerlyNode({ config, storage, webRoot: "dist/client" }).listen(PORT);

console.log(`react-node listening on :${PORT}`);
