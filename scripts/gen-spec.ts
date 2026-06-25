import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSpecIR } from "../packages/server/src/spec/ir.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../packages/server/spec");
const outPath = resolve(outDir, "baerly.spec.json");

mkdirSync(outDir, { recursive: true });
// Trailing newline so the file is POSIX-clean.
writeFileSync(outPath, `${JSON.stringify(buildSpecIR(), null, 2)}\n`, "utf8");
// Apply oxfmt so the artifact is canonically formatted — no flip-flop in the
// drift gate. Inherit stdio so an oxfmt failure surfaces and aborts the
// generator (a swallowed failure would leave un-formatted JSON on disk).
execSync(`pnpm exec oxfmt "${outPath}"`, { cwd: resolve(here, ".."), stdio: "inherit" });
console.log(`Wrote ${outPath}`);
