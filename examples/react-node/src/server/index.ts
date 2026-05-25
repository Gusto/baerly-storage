/**
 * Server entry for react-node. `baerlyNode(opts)` reads
 * `opts.config.auth` to choose its verifier — the scaffold ships
 * `auth: "none"`, so every request resolves to `config.tenant`
 * with no header check. The schema declared in
 * `baerly.config.ts:collections.notes.schema` runs server-side on
 * every write. See AGENTS.md "Going to production" for the recipe
 * to flip `auth` or wire a custom verifier.
 *
 * Storage: AWS S3 by default; set `R2_ACCOUNT_ID` to switch to
 * Cloudflare R2 via the S3-compat endpoint.
 */
import { baerlyNode, r2Storage, s3Storage } from "baerly-storage/node";
import type { Storage } from "baerly-storage";
import config from "../../baerly.config.ts";

const reqEnv = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
};

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

const PORT = Number(process.env["PORT"] ?? 8080);

await baerlyNode({ config, storage }).listen(PORT);

console.log(`react-node listening on :${PORT}`);
