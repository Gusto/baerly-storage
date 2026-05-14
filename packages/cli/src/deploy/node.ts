/**
 * `baerly deploy --target=node` — emit reference Node-deploy
 * artifacts and print next-step instructions.
 *
 * Unlike `baerly deploy --target=cloudflare` (which shells out to
 * `wrangler deploy`), this command does NOT actually deploy. The
 * Node deployment surface is heterogeneous (Docker / k8s / systemd /
 * pm2 / Cloud Run / Fly / Render / ECS / bare-metal), so the
 * command's job is to emit the build inputs and let the user pick
 * the runtime.
 *
 * Files emitted at `apps/server/`:
 *   - `Dockerfile` — distroless final stage, non-root user,
 *     Node-script HEALTHCHECK.
 *   - `.dockerignore` — keeps the build context small.
 *   - `healthcheck.js` — the Node script the Dockerfile invokes.
 *   - `pm2.config.cjs` — pm2 ecosystem file.
 *   - `systemd/baerly.service` — systemd unit (user copies to
 *     `/etc/systemd/system/`).
 *   - `.env.example` — documents the env vars the server reads.
 *
 * Idempotent: files identical to the templated shape are left
 * alone (exit 0). Files that DIFFER from the shape produce an
 * exit-1 "user has hand-edited" message unless `--force` is set.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BaerlyError } from "@baerly/protocol";
import pc from "picocolors";
import type { AppConfig } from "../config.ts";

/**
 * Files this command writes (relative to `repoRoot/apps/server/`).
 * Order is significant — directory entries (`systemd/`) must exist
 * before files under them.
 */
const EMITTED_FILES: readonly { readonly rel: string; readonly isDir?: boolean }[] = [
  { rel: "Dockerfile" },
  { rel: ".dockerignore" },
  { rel: "healthcheck.js" },
  { rel: "pm2.config.cjs" },
  { rel: "systemd", isDir: true },
  { rel: "systemd/baerly.service" },
  { rel: ".env.example" },
];

/**
 * Resolve the on-disk source of each templated file. The
 * `examples/minimal-node/` tree is the canonical Node-deploy
 * reference shape; the CLI reads from it directly so a template
 * edit is picked up by both the scaffolder and
 * `baerly deploy --target=node`.
 *
 * We intentionally do NOT add a runtime dep on `create-baerly` for
 * this resolver (see the parallel rationale in `../config.ts`).
 * The relative walk works in workspace dev mode (running straight
 * from `src/` via Node's strip-types runtime); a published-cli
 * consumer is not in scope today.
 */
const sourcePathFor = (rel: string): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/cli/src/deploy → packages/cli/src → packages/cli →
  // packages → repo-root → examples/minimal-node/apps/server/<rel>.
  return resolve(here, "..", "..", "..", "..", "examples", "minimal-node", "apps", "server", rel);
};

/**
 * Substitute the example's manifest sentinels (literal substrings
 * like `minimal-node` / `minimal-demo`) with the user's resolved
 * config values. Mirrors `@baerly/create-baerly`'s `substituteText`
 * — longest-first to keep nested sentinels stable — but inlined
 * here so the CLI does NOT take a runtime dep on `create-baerly`
 * (see the rationale in `../config.ts`).
 *
 * Unknown `fromKey`s on the manifest are skipped (the sentinel is
 * left in place) rather than erroring; the scaffolder uses the same
 * policy.
 */
const substituteSentinels = (
  text: string,
  renames: readonly { readonly from: string; readonly to: string }[],
): string => {
  const sorted = renames.toSorted((a, b) => b.from.length - a.from.length);
  let out = text;
  for (const r of sorted) out = out.replaceAll(r.from, r.to);
  return out;
};

/**
 * Load the example's `.baerly/scaffold.json` manifest and resolve
 * each rename's `fromKey` against `vars`. Renames whose `fromKey`
 * is absent from `vars` are dropped.
 */
const loadRenames = (vars: Record<string, string>): { from: string; to: string }[] => {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/cli/src/deploy → packages/cli/src → packages/cli →
  // packages → repo-root → examples/minimal-node/.baerly/scaffold.json.
  const manifestPath = resolve(
    here,
    "..",
    "..",
    "..",
    "..",
    "examples",
    "minimal-node",
    ".baerly",
    "scaffold.json",
  );
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    renames?: { from: string; fromKey: string }[];
  };
  const renames = raw.renames ?? [];
  return renames.flatMap((r) =>
    Object.hasOwn(vars, r.fromKey) ? [{ from: r.from, to: vars[r.fromKey]! }] : [],
  );
};

/**
 * Emit reference Node-deploy artifacts to `repoRoot/apps/server/`.
 *
 * @returns 0 on success (files emitted or already up to date);
 *   1 when one or more files have been hand-edited and `--force`
 *   was not set.
 * @throws BaerlyError code="InvalidConfig" — `apps/server/` does
 *   not exist (no scaffolded layout to write into).
 */
export const deployNode = async (
  config: AppConfig,
  opts: { readonly force?: boolean; readonly cwd?: string } = {},
): Promise<number> => {
  const repoRoot = opts.cwd ?? config.repoRoot;
  const serverDir = resolve(repoRoot, "apps", "server");
  if (!existsSync(serverDir)) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly deploy --target=node: ${serverDir} missing. Expected the scaffolded layout.`,
    );
  }

  const vars: Record<string, string> = {
    appName: config.app,
    tenant: config.tenant,
  };
  const renames = loadRenames(vars);

  const conflicts: { rel: string }[] = [];
  for (const ent of EMITTED_FILES) {
    const dst = join(serverDir, ent.rel);
    if (ent.isDir === true) {
      if (!existsSync(dst)) mkdirSync(dst, { recursive: true });
      continue;
    }
    const expected = substituteSentinels(readFileSync(sourcePathFor(ent.rel), "utf8"), renames);
    if (existsSync(dst)) {
      const actual = readFileSync(dst, "utf8");
      if (actual === expected) continue;
      conflicts.push({ rel: ent.rel });
      if (opts.force !== true) continue;
    }
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, expected);
  }

  if (conflicts.length > 0 && opts.force !== true) {
    process.stderr.write(
      pc.yellow(
        `baerly deploy --target=node: ${conflicts.length} file(s) differ from the emitted shape:\n`,
      ),
    );
    for (const c of conflicts) {
      process.stderr.write(`  ${c.rel}: hand-edited (use --force to overwrite)\n`);
    }
    return 1;
  }

  // Print next steps.
  process.stdout.write(`${pc.green("✓")} Emitted Node deploy artifacts to ${serverDir}\n\n`);
  process.stdout.write("Next steps (pick one):\n\n");
  process.stdout.write("  Docker:\n");
  process.stdout.write(`    docker build -t ${config.app}:latest -f apps/server/Dockerfile .\n`);
  process.stdout.write(
    `    docker run -p 8080:8080 --env-file apps/server/.env ${config.app}:latest\n\n`,
  );
  process.stdout.write("  pm2:\n");
  process.stdout.write(`    pnpm -F server build\n`);
  process.stdout.write(`    pm2 start apps/server/pm2.config.cjs\n\n`);
  process.stdout.write("  systemd:\n");
  process.stdout.write(`    sudo cp apps/server/systemd/baerly.service /etc/systemd/system/\n`);
  process.stdout.write(
    `    sudo systemctl daemon-reload && sudo systemctl enable --now baerly\n\n`,
  );
  process.stdout.write(`Then verify: curl http://localhost:8080/v1/healthz\n`);

  return 0;
};
