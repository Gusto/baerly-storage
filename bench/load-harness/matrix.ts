/**
 * Matrix runner. Sequential sweep over preset × variant × cache-mode.
 * Sequential (not parallel) because `node-minio` shares one Minio
 * instance and parallel runs would race on `current.json` keys, and
 * `memory` parallel runs would race on the singleton MemoryStorage.
 *
 * Output: one timestamped subdirectory under `--output-dir` (default
 * `bench/results/load/matrix-<timestamp>/`) containing one JSON per
 * cell of the matrix. DuckDB consumes the whole subdirectory via
 * `read_json_auto('bench/results/load/matrix-*\/*.json')`.
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const PRESETS = [
  "recent-first-crud",
  "one-hot-tenant",
  "update-heavy-messy-log",
  "hot-tenant-compaction-debt",
  "many-tiny-apps",
  "rag-document-store",
  "chat-conversation-store",
];
const VARIANTS =
  process.env.MINIO === "1" ? ["memory", "local-fs", "node-minio"] : ["memory", "local-fs"];
const CACHE_MODES = ["cold", "metadata-warm", "data-warm", "tiny-cache"];

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outBase = join("bench/results/load", `matrix-${stamp}`);
await mkdir(outBase, { recursive: true });

const seed = Number(process.env.SEED ?? "42");
const records = Number(process.env.RECORDS ?? "1000");
const ops = Number(process.env.OPS ?? "1000");

let failures = 0;
for (const preset of PRESETS) {
  for (const variant of VARIANTS) {
    for (const cache of CACHE_MODES) {
      const code = await run([
        "--import",
        "./bench/register-hooks.mjs",
        "bench/load-harness/cli.ts",
        `--preset=${preset}`,
        `--variant=${variant}`,
        `--cache-mode=${cache}`,
        `--records=${records}`,
        `--ops=${ops}`,
        `--seed=${seed}`,
        `--output-dir=${outBase}`,
      ]);
      if (code !== 0) failures++;
    }
  }
}

process.exit(failures === 0 ? 0 : 1);

function run(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("node", args, { stdio: "inherit" });
    proc.on("exit", (code) => resolve(code ?? 1));
  });
}
