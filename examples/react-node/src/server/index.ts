/**
 * Server entry for react-node. `baerlyNode(opts)` reads
 * `opts.config.auth` to choose its verifier — the scaffold ships
 * `auth: "none"`, so every request resolves to `config.tenant`
 * with no header check. The schema declared in
 * `baerly.config.ts:collections.notes.schema` runs server-side on
 * every write. See AGENTS.md "Going to production" for the recipe
 * to flip `auth` or wire a custom verifier.
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
import { baerlyNode } from "@gusto/baerly-storage/node";
import config from "../../baerly.config.ts";
import { resolveStorage } from "./resolve-storage.ts";

// Pick the storage backend from the environment (R2 / S3 / local-fs),
// failing loud if a deployment has no bucket. The policy lives in
// `./resolve-storage.ts` — edit it there to change how your app maps
// env vars to storage.
const { storage, label: storageLabel } = resolveStorage();

// Announce the effective backend so the chosen store (and any surprise
// local-fs fallback) is visible in the deploy logs, not a surprise.
console.log(`[baerly] storage=${storageLabel}`);

const PORT = Number(process.env["PORT"] ?? 8080);

// `webRoot` serves the Vite-built SPA from `dist/client/` (the
// `vite.config.ts` `build.outDir`) in production; `/v1/*` is handled
// by the kernel, everything else falls back to the SPA shell.
await baerlyNode({ config, storage, webRoot: "dist/client" }).listen(PORT);

console.log(`react-node listening on :${PORT}`);
