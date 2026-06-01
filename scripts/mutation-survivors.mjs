#!/usr/bin/env node
// Parse Stryker's mutation-testing-elements JSON report into an
// agent-readable survivor worklist. The HTML report renders this exact
// JSON; an LLM should read the JSON, not the DOM.
//
// Usage: node scripts/mutation-survivors.mjs [path] [--file <substr>]
//   path        defaults to reports/mutation/mutation.json
//   --file STR  only show files whose path contains STR
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const fileFilterIdx = args.indexOf("--file");
const fileFilter = fileFilterIdx >= 0 ? args[fileFilterIdx + 1] : null;
// Index of the `--file` value to skip when scanning for the positional
// path arg. -1 (not 0) when `--file` is absent, so a custom report path
// passed as the first positional is honored rather than skipped.
const fileFilterValueIdx = fileFilterIdx >= 0 ? fileFilterIdx + 1 : -1;
const path =
  args.find((a, i) => !a.startsWith("--") && i !== fileFilterValueIdx) ??
  "reports/mutation/mutation.json";

const report = JSON.parse(readFileSync(path, "utf8"));
const byFile = new Map();
let survived = 0;
let noCoverage = 0;

for (const [file, data] of Object.entries(report.files)) {
  if (fileFilter && !file.includes(fileFilter)) {
    continue;
  }
  for (const m of data.mutants) {
    if (m.status !== "Survived" && m.status !== "NoCoverage") {
      continue;
    }
    if (m.status === "Survived") {
      survived++;
    } else {
      noCoverage++;
    }
    if (!byFile.has(file)) {
      byFile.set(file, []);
    }
    byFile.get(file).push({
      line: m.location.start.line,
      status: m.status,
      mutator: m.mutatorName,
      replacement: String(m.replacement ?? "")
        .replace(/\s+/g, " ")
        .slice(0, 60),
    });
  }
}

const files = [...byFile.entries()].toSorted((a, b) => b[1].length - a[1].length);
for (const [file, items] of files) {
  items.sort((a, b) => a.line - b.line);
  console.log(`\n${file}  (${items.length})`);
  for (const r of items) {
    console.log(
      `  ${r.status.padEnd(10)} L${String(r.line).padStart(4)}  ${r.mutator}  → ${r.replacement}`,
    );
  }
}
console.log(`\nTOTAL  Survived=${survived}  NoCoverage=${noCoverage}`);
process.exitCode = survived + noCoverage > 0 ? 1 : 0;
