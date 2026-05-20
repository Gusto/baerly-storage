/**
 * `baerly deploy --target=cloudflare` — one-command Cloudflare
 * Workers deploy.
 *
 * Behavior:
 *   1. Locate `wrangler.jsonc` at the package root.
 *   2. Sniff `wrangler deploy --help` for the `--x-provision` flag.
 *   3. When present, invoke
 *      `wrangler deploy --x-provision --x-auto-create` and rely on
 *      Wrangler to auto-create the declared R2 buckets.
 *   4. When absent, parse `wrangler.jsonc` for declared
 *      `r2_buckets[]`, ensure each bucket exists (creating with
 *      `wrangler r2 bucket create` when missing), then run
 *      `wrangler deploy` without the experimental flag.
 *   5. Warn (non-fatal) on any `requiredSecret` not present in the
 *      Wrangler-reported secret list.
 *
 * No `wrangler secret put` is invoked — that requires interactive
 * stdin and Wrangler is the authority on the user's secret store.
 * Missing secrets surface as actionable hints printed to stderr.
 *
 * Tests inject a {@link ProcessRunner} mock; production uses the
 * default `node:child_process.spawn`-backed implementation.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { BaerlyError } from "@baerly/protocol";
import type { AppConfig } from "../config.ts";
import { defaultRunner, type ProcessRunner } from "../runner.ts";

export type { ProcessRunner };

/**
 * Declared R2 binding extracted from `wrangler.jsonc`. Subset of
 * Wrangler's full schema — only the fields `baerly` cares about.
 */
export interface R2BindingDeclaration {
  readonly binding: string;
  readonly bucket_name: string;
}

/** Path to `wrangler.jsonc` at the package root. */
const wranglerPathFor = (repoRoot: string): string => resolve(repoRoot, "wrangler.jsonc");

/**
 * Parse the declared `r2_buckets[]` array from a `wrangler.jsonc`
 * file. Tolerates comments + trailing commas via `jsonc-parser`.
 *
 * @throws BaerlyError code="InvalidConfig" — file missing, parse
 *   error, or any entry missing `binding` / `bucket_name`.
 */
export const parseR2Bindings = (wranglerPath: string): readonly R2BindingDeclaration[] => {
  if (!existsSync(wranglerPath)) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly deploy: ${wranglerPath} missing. Expected wrangler.jsonc at the package root.`,
    );
  }
  const text = readFileSync(wranglerPath, "utf8");
  const errors: ParseError[] = [];
  const obj = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as
    | { r2_buckets?: unknown }
    | undefined;
  if (errors.length > 0) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly deploy: ${wranglerPath} is not valid JSONC (${errors.length} error${errors.length === 1 ? "" : "s"}; first at offset ${errors[0]?.offset ?? "?"})`,
    );
  }
  if (obj === undefined || typeof obj !== "object") {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly deploy: ${wranglerPath} did not parse to an object`,
    );
  }
  const buckets = obj.r2_buckets;
  if (buckets === undefined) {
    return [];
  }
  if (!Array.isArray(buckets)) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly deploy: ${wranglerPath}: r2_buckets must be an array`,
    );
  }
  const out: R2BindingDeclaration[] = [];
  for (const b of buckets) {
    if (b === null || typeof b !== "object") {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly deploy: ${wranglerPath}: r2_buckets entry must be an object`,
      );
    }
    const entry = b as { binding?: unknown; bucket_name?: unknown };
    if (typeof entry.binding !== "string" || entry.binding.length === 0) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly deploy: ${wranglerPath}: r2_buckets[].binding must be a non-empty string`,
      );
    }
    if (typeof entry.bucket_name !== "string" || entry.bucket_name.length === 0) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly deploy: ${wranglerPath}: r2_buckets[].bucket_name must be a non-empty string`,
      );
    }
    out.push({ binding: entry.binding, bucket_name: entry.bucket_name });
  }
  return out;
};

/**
 * Walk the declared R2 bindings; for each, run `wrangler r2 bucket
 * info <name>` and, on non-zero exit, `wrangler r2 bucket create
 * <name>`. Used as the fallback when `wrangler --x-provision` is
 * unavailable, and directly invoked by `baerly doctor
 * --target=cloudflare --fix`.
 *
 * @throws BaerlyError code="NetworkError" — bucket creation
 *   reported a non-zero exit (Wrangler's own error already on
 *   stderr).
 */
export const ensureBindings = async (
  runner: ProcessRunner,
  cwd: string,
  wranglerPath: string,
): Promise<void> => {
  const declared = parseR2Bindings(wranglerPath);
  for (const { bucket_name } of declared) {
    const info = await runner.run("wrangler", ["r2", "bucket", "info", bucket_name], cwd);
    if (info.code === 0) {
      continue;
    }
    process.stderr.write(`baerly deploy: creating R2 bucket ${bucket_name}\n`);
    const created = await runner.run("wrangler", ["r2", "bucket", "create", bucket_name], cwd);
    if (created.code !== 0) {
      throw new BaerlyError(
        "NetworkError",
        `baerly deploy: failed to create R2 bucket ${bucket_name} (exit ${created.code})`,
      );
    }
  }
};

/**
 * Best-effort secret check. `wrangler secret list` emits a JSON
 * array of `{ name, type }` when stdout is piped (Wrangler 4.x
 * default). We parse, diff against `required`, and print
 * actionable hints for each missing secret. Non-fatal — a missing
 * secret blocks the Verifier at runtime, not at deploy time.
 */
const warnOnMissingSecrets = async (
  runner: ProcessRunner,
  cwd: string,
  required: readonly string[],
): Promise<void> => {
  const r = await runner.run("wrangler", ["secret", "list"], cwd);
  if (r.code !== 0) {
    process.stderr.write("baerly deploy: could not list secrets; skipping check\n");
    return;
  }
  let configured: readonly string[];
  try {
    const parsed = JSON.parse(r.stdout) as unknown;
    if (!Array.isArray(parsed)) {
      return;
    }
    configured = parsed
      .map((s) =>
        s !== null && typeof s === "object" ? (s as { name?: unknown }).name : undefined,
      )
      .filter((n): n is string => typeof n === "string");
  } catch {
    return;
  }
  for (const name of required) {
    if (!configured.includes(name)) {
      process.stderr.write(
        `baerly deploy: secret ${name} is required but unset. ` +
          `Run: wrangler secret put ${name}\n`,
      );
    }
  }
};

/**
 * Deploy a baerly app to Cloudflare Workers. Returns the integer
 * exit code from the underlying `wrangler deploy` invocation.
 *
 * @throws BaerlyError code="InvalidConfig" — `wrangler.jsonc`
 *   missing or unparseable.
 * @throws BaerlyError code="NetworkError" — the fallback path
 *   could not create a declared R2 bucket.
 */
export const deployCloudflare = async (
  config: AppConfig,
  opts: { readonly runner?: ProcessRunner; readonly cwd?: string } = {},
): Promise<number> => {
  const runner = opts.runner ?? defaultRunner({ tee: true });
  const repoRoot = opts.cwd ?? config.repoRoot;
  const wranglerPath = wranglerPathFor(repoRoot);
  if (!existsSync(wranglerPath)) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly deploy: ${wranglerPath} missing. Expected wrangler.jsonc at the package root.`,
    );
  }

  // Sniff Wrangler for --x-provision support.
  const help = await runner.run("wrangler", ["deploy", "--help"], repoRoot);
  const hasXProvision = help.code === 0 && help.stdout.includes("--x-provision");

  await warnOnMissingSecrets(runner, repoRoot, config.requiredSecrets ?? ["SHARED_SECRET"]);

  if (hasXProvision) {
    const r = await runner.run(
      "wrangler",
      ["deploy", "--x-provision", "--x-auto-create"],
      repoRoot,
    );
    return r.code;
  }

  // Fallback: provision via the doctor path then deploy.
  process.stderr.write(
    "baerly deploy: wrangler --x-provision unavailable; falling back to manual provisioning\n",
  );
  await ensureBindings(runner, repoRoot, wranglerPath);
  const r = await runner.run("wrangler", ["deploy"], repoRoot);
  return r.code;
};
