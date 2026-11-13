#!/usr/bin/env node
// Old-binary harness: installs published `@gusto/baerly-storage` versions
// into isolated scratch dirs, seeds a synthetic corpus with each version's
// own API, and dumps it with that version's own `baerly admin dump`.
// See README.md in this directory.
//
//   pnpm migration:old-binary [--versions 0.1.0,0.6.0] [--out <dir>]
//        [--bucket <uri-template>] [--seed N] [--rows N] [--tail-writes N]
//
// `--bucket` may contain `{version}`; the default is
// `file://<out>/<version>/bucket`. Only `file:///` buckets can be SEEDED
// today; the dump step accepts any URI the old CLI understands.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const { values: args } = parseArgs({
  options: {
    versions: { type: "string", default: "0.1.0,0.6.0" },
    out: { type: "string", default: join(tmpdir(), `baerly-migration-proof-${Date.now()}`) },
    bucket: { type: "string" },
    seed: { type: "string", default: "1" },
    rows: { type: "string", default: "48" },
    "tail-writes": { type: "string", default: "130" },
    "skip-install": { type: "boolean", default: false },
  },
});

const out = resolve(args.out);
// Corporate TLS proxy: trust the system CA store for npm and node fetch.
const env = { ...process.env };
if (!/--use-system-ca/.test(env["NODE_OPTIONS"] ?? "")) {
  env["NODE_OPTIONS"] = `${env["NODE_OPTIONS"] ?? ""} --use-system-ca`.trim();
}

const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { env, encoding: "utf8", ...opts });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${argv.join(" ")} exited ${r.status}\n${r.stdout ?? ""}\n${r.stderr ?? ""}`,
    );
  }
  return r;
};

const results = [];
for (const version of args.versions.split(",").map((v) => v.trim())) {
  const dir = join(out, version);
  const bucketUri = (args.bucket ?? `file://${dir}/bucket`).replaceAll("{version}", version);
  mkdirSync(dir, { recursive: true });

  // 1. Install the published package, no lifecycle scripts.
  const pkgJson = join(dir, "node_modules/@gusto/baerly-storage/package.json");
  const installed = () =>
    existsSync(pkgJson) && JSON.parse(readFileSync(pkgJson, "utf8")).version === version;
  if (!args["skip-install"] && !installed()) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "old-binary", private: true }));
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `@gusto/baerly-storage@${version}`,
      ],
      { cwd: dir },
    );
  }
  if (!installed()) {
    throw new Error(`@gusto/baerly-storage@${version} is not installed under ${dir}`);
  }

  // 2. Seed with that version's own API.
  if (!bucketUri.startsWith("file:///")) {
    throw new Error(
      `seeding supports file:/// buckets only (got ${bucketUri}); Minio s3:// seeding is step 4`,
    );
  }
  const root = bucketUri.slice("file://".length);
  mkdirSync(root, { recursive: true });
  if (readdirSync(root).length > 0) {
    throw new Error(
      `bucket root ${root} is not empty; use a fresh --out (the default is timestamped)`,
    );
  }
  const expectedPath = join(dir, "expected.json");
  const seeded = run(
    process.execPath,
    [
      join(here, "seed-corpus.mjs"),
      "--pkg",
      dir,
      "--root",
      root,
      "--out",
      expectedPath,
      "--seed",
      args.seed,
      "--rows",
      args.rows,
      "--tail-writes",
      args["tail-writes"],
    ],
    { cwd: dir },
  );
  process.stdout.write(seeded.stdout);
  const expected = JSON.parse(readFileSync(expectedPath, "utf8"));

  // 3. Dump with that version's own CLI.
  const cli = join(dir, "node_modules/@gusto/baerly-storage/dist/baerly.js");
  const dumpDir = join(dir, "dump");
  mkdirSync(dumpDir, { recursive: true });
  for (const collection of expected.collections) {
    const d = run(
      process.execPath,
      [
        cli,
        "admin",
        "dump",
        "--bucket",
        bucketUri,
        "--app",
        expected.app,
        "--tenant",
        expected.tenant,
        "--collection",
        collection,
      ],
      { cwd: dir, maxBuffer: 256 * 1024 * 1024 },
    );
    writeFileSync(join(dumpDir, `${collection}.ndjson`), d.stdout);

    // The dump must hold exactly the rows the seeder believes are live.
    // Compare order-insensitively; byte-level checks are step 4's job.
    const dumped = d.stdout
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    const key = (r) => JSON.stringify(sortKeys(r));
    const got = dumped.map(key).toSorted();
    const want = expected.rows[collection].map(key).toSorted();
    if (got.length !== want.length || got.some((g, i) => g !== want[i])) {
      throw new Error(
        `${version} ${collection}: dump (${got.length} rows) differs from seeded model (${want.length} rows); see ${join(dumpDir, `${collection}.ndjson`)}`,
      );
    }
    console.log(`[harness ${version}] dump ${collection}: ${dumped.length} rows match the model`);
  }
  results.push({ version, bucketUri, dir, expected: expectedPath, dumps: dumpDir });
}

writeFileSync(join(out, "manifest.json"), JSON.stringify(results, null, 2) + "\n");
console.log(`\nharness output: ${out}\n${JSON.stringify(results, null, 2)}`);

function sortKeys(v) {
  if (Array.isArray(v)) {
    return v.map(sortKeys);
  }
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  }
  return v;
}
