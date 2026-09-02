#!/usr/bin/env node
// Thin wrangler wrapper for the workload-ceiling study Worker (Task 8 Step
// 10 — not run by `pnpm verify`/`pnpm test`, never wired into a release
// script). Resolves Cloudflare auth the same way
// `../measurement/workload-ceiling-collect.ts` does: `CF_API_TOKEN` +
// `CF_ACCOUNT_ID` env vars if both are set, otherwise a repo-scoped
// `credentials/cloudflare-deploy.json` (gitignored — see
// `tests/fixtures/endpoint-creds.ts`'s `loadCloudflareDeployCreds`).
//
// Set `WORKLOAD_CEILING_TIER=free` to use `credentials/cloudflare-deploy-free.json`
// instead of `credentials/cloudflare-deploy.json`.
//
// Either way, the resolved token/account id are injected only into the spawned
// `wrangler` child's environment — never printed, never written to disk,
// never exported into the calling shell.
//
// Usage: node bench/workload-ceiling-worker/deploy.mjs <wrangler subcommand and args...>
//   node bench/workload-ceiling-worker/deploy.mjs deploy --name baerly-storage
//   node bench/workload-ceiling-worker/deploy.mjs secret put WORKLOAD_CEILING_SHARED_SECRET --name baerly-storage
//   node bench/workload-ceiling-worker/deploy.mjs delete --name baerly-storage
//
// NOTE: `secret put` mints a NEW Worker version (a fresh script_version in
// analytics — observed 2026-08-20: re-putting the secret changed the serving
// version from 9a1122b4… to bf21bd73… with no code deploy). The capture
// protocol requires a single script_version across all cells of a sweep, so
// put secrets BEFORE a capture starts and never during one; and remember any
// "deployed version" you recorded earlier is now stale — re-check with
// `deployments list`.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const WRANGLER_CONFIG = join(HERE, "wrangler.jsonc");

function resolveTier() {
  const tier = process.env["WORKLOAD_CEILING_TIER"]?.toLowerCase().trim();
  return tier === "free" ? "free" : "paid";
}

function deployCredsFilename(tier) {
  return tier === "free" ? "cloudflare-deploy-free.json" : "cloudflare-deploy.json";
}

async function loadDeployCreds() {
  const tier = resolveTier();
  const filename = deployCredsFilename(tier);
  try {
    const raw = await readFile(join(REPO_ROOT, "credentials", filename), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// A defined-but-blank env var must not count as "set" — it would pass the
// undefined-only checks in resolveAuth and surface later as a confusing
// wrangler auth failure instead of this script's clear usage error.
const present = (v) => v !== undefined && v.trim() !== "";

async function resolveAuth() {
  const tier = resolveTier();
  const envToken = process.env["CF_API_TOKEN"];
  const envAccount = process.env["CF_ACCOUNT_ID"];
  if (present(envToken) && present(envAccount)) {
    return { apiToken: envToken, accountId: envAccount };
  }
  const fileCreds = await loadDeployCreds();
  const apiToken = present(envToken) ? envToken : fileCreds?.api_token;
  const accountId = present(envAccount) ? envAccount : fileCreds?.account_id;
  if (!present(apiToken) || !present(accountId)) {
    const filename = deployCredsFilename(tier);
    console.error(
      `workload-ceiling-worker/deploy.mjs: requires CF_API_TOKEN + CF_ACCOUNT_ID ` +
        `(env vars) or credentials/${filename} ({ api_token, account_id }).\n` +
        `Set WORKLOAD_CEILING_TIER=free to use credentials/cloudflare-deploy-free.json ` +
        `instead of credentials/cloudflare-deploy.json.`,
    );
    return null;
  }
  console.log(
    `workload-ceiling-worker/deploy.mjs: using ${tier} tier (credentials/${deployCredsFilename(tier)})`,
  );
  return { apiToken, accountId };
}

// The token behind this script has account-wide `Workers Scripts:Edit` —
// Cloudflare's API token permission model has no per-script resource scope
// to narrow that with (see bench/workload-ceiling-worker/README.md
// §"Token scope"). This exact-name check is the code-level substitute: it
// must match `WORKLOAD_CEILING_WORKER_NAME` in
// `../measurement/workload-ceiling-collect.ts` (the study's one
// already-deployed, reused Worker — see that constant's doc comment for why
// this plan doesn't mint a uniquely-named deployment per run), and every
// wrangler invocation below is refused unless its `--name` matches exactly,
// so a typo'd or copy-pasted `--name` can never reach an unrelated script
// even though the credential technically could.
const STUDY_WORKER_NAME = "baerly-storage";

function extractName(args) {
  const eqForm = args.find((arg) => arg.startsWith("--name="));
  if (eqForm !== undefined) {
    return eqForm.slice("--name=".length);
  }
  const flagIndex = args.indexOf("--name");
  return flagIndex === -1 ? undefined : args[flagIndex + 1];
}

const wranglerArgs = process.argv.slice(2);
if (wranglerArgs.length === 0) {
  console.error("usage: node bench/workload-ceiling-worker/deploy.mjs <wrangler subcommand...>");
  process.exit(1);
}

const targetName = extractName(wranglerArgs);
if (targetName !== STUDY_WORKER_NAME) {
  console.error(
    `workload-ceiling-worker/deploy.mjs: refusing to run — every invocation must pass ` +
      `--name "${STUDY_WORKER_NAME}" exactly (got ${
        targetName === undefined ? "no --name" : JSON.stringify(targetName)
      }). This account-wide-scoped token is restricted in code to this study's ` +
      `one reused Worker only.`,
  );
  process.exit(1);
}

const auth = await resolveAuth();
if (auth === null) {
  process.exit(1);
}

const child = spawn("pnpm", ["exec", "wrangler", ...wranglerArgs, "--config", WRANGLER_CONFIG], {
  stdio: "inherit",
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    CLOUDFLARE_API_TOKEN: auth.apiToken,
    CLOUDFLARE_ACCOUNT_ID: auth.accountId,
  },
});
child.on("exit", (code) => {
  process.exit(code ?? 1);
});
