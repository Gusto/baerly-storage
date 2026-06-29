#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { splitFrontmatter } from "./lib/frontmatter.mjs";

// VERIFY_DOCS_TAXONOMY_ROOT lets unit tests point at a temp dir;
// default to the repo root resolved from this script's location.
const ROOT = process.env.VERIFY_DOCS_TAXONOMY_ROOT ?? resolve(import.meta.dirname, "..");
const SPEC_DIR = join(ROOT, "docs", "spec");
const ADR_DIR = join(ROOT, "docs", "adr");

// Controlled `doc_type:` vocabulary introduced with the docs taxonomy.
// Each value mirrors a routing section in the directory's README index;
// keep these in sync with the headings in docs/spec/README.md and
// docs/adr/README.md. This lint enforces routing metadata + index
// coverage only — it deliberately encodes no protocol facts.
const INDEX_DOC_TYPE = "evidence-index";
const ADR_DOC_TYPE = "adr";
const SPEC_CONTENT_DOC_TYPES = new Set([
  "current-contract",
  "verification",
  "semantic-reference",
  "rationale",
  "historical",
  "adapter-edge-case",
]);
const ALL_DOC_TYPES = new Set([INDEX_DOC_TYPE, ADR_DOC_TYPE, ...SPEC_CONTENT_DOC_TYPES]);
const SPEC_SECTION_BY_DOC_TYPE = new Map([
  ["current-contract", "Current contracts"],
  ["semantic-reference", "Semantic references"],
  ["verification", "Verification"],
  ["adapter-edge-case", "Adapter edge cases"],
  ["historical", "Historical, rationale & evidence"],
  ["rationale", "Historical, rationale & evidence"],
]);

// Spec docs that are retained for history/rationale and must never be
// filed as a live contract — neither via `doc_type:` nor by being listed
// under the README's "Current contracts" section.
const NOT_CURRENT_CONTRACT = new Set(["writer-fence-adversarial-model.md", "prior-art.md"]);

const findings = [];

function rel(path) {
  return relative(ROOT, path);
}

// Returns the `doc_type:` string, or undefined after pushing a finding
// when the frontmatter is missing/unparseable or has no string doc_type.
function docTypeOf(path) {
  const { raw } = splitFrontmatter(readFileSync(path, "utf8"));
  if (raw === undefined) {
    findings.push(`${rel(path)}: missing YAML frontmatter`);
    findings.push(`  To fix: add a \`---\` fenced frontmatter block with a \`doc_type:\` field.`);
    return undefined;
  }
  let fm;
  try {
    fm = parseYaml(raw);
  } catch (error) {
    findings.push(`${rel(path)}: frontmatter YAML parse error — ${error.message}`);
    return undefined;
  }
  if (!fm || typeof fm.doc_type !== "string") {
    findings.push(`${rel(path)}: missing \`doc_type:\` frontmatter`);
    findings.push(
      `  To fix: add \`doc_type: <one of: ${[...ALL_DOC_TYPES].join(", ")}>\` to the frontmatter.`,
    );
    return undefined;
  }
  return fm.doc_type;
}

// Same-directory `*.md` link targets in a README body: anchors stripped,
// `./` normalised, external/cross-directory links ignored. Used for index
// coverage only, so it matches the index's own siblings.
function localMarkdownLinks(body) {
  const links = [];
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = m[1].trim().split("#")[0];
    if (target.startsWith("./")) {
      target = target.slice(2);
    }
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.includes("/")) {
      continue; // empty/anchor, scheme (http:, mailto:), or cross-directory
    }
    if (target.endsWith(".md")) {
      links.push(target);
    }
  }
  return links;
}

// Intentionally a flat, top-level scan (spec/*.md + adr/*.md only): the
// non-recursive `readdirSync` is by design. Subdirectories such as
// docs/spec/attachments/ (regenerated evidence, `.remarkignore`'d) are out
// of scope — recursing would wrongly demand `doc_type:` frontmatter on
// those generated artifacts.
function topLevelMarkdown(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .toSorted();
}

// `## ` H2 sections of a README body → array of lines under each heading.
function sectionsByH2(body) {
  const sections = new Map();
  let current = null;
  for (const line of body.split("\n")) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      current = h2[1];
      sections.set(current, []);
    } else if (current !== null) {
      sections.get(current).push(line);
    }
  }
  return sections;
}

// Assert every content doc under `dir` is linked from its README index
// exactly once. `contentFiles` excludes the README itself.
//
// This checks only that each content file IS linked (and linked once) — it
// does NOT verify that link targets resolve to real files. Target existence
// is owned by `remark-validate-links --frail`, which runs right after this in
// the same `verify:docs` chain; duplicating that check here would be redundant.
function checkIndexCoverage(dir, contentFiles) {
  const indexPath = join(dir, "README.md");
  if (!existsSync(indexPath)) {
    findings.push(`${rel(indexPath)}: index README is missing`);
    return null;
  }
  const { body } = splitFrontmatter(readFileSync(indexPath, "utf8"));
  const counts = new Map();
  for (const target of localMarkdownLinks(body)) {
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  for (const file of contentFiles) {
    const n = counts.get(file) ?? 0;
    if (n === 0) {
      findings.push(`${rel(join(dir, file))}: not linked from ${rel(indexPath)}`);
      findings.push(
        `  To fix: add a markdown link to ${file} under the matching section of ${rel(indexPath)}.`,
      );
    } else if (n > 1) {
      findings.push(`${rel(indexPath)}: links ${file} ${n} times (expected exactly once)`);
      findings.push(`  To fix: remove the duplicate link; index each doc exactly once.`);
    }
  }
  return body;
}

// --- ADRs: numbered records are `adr`, the README is `evidence-index`. ---
const adrFiles = topLevelMarkdown(ADR_DIR);
for (const file of adrFiles) {
  const path = join(ADR_DIR, file);
  const docType = docTypeOf(path);
  if (docType === undefined) {
    continue;
  }
  if (file === "README.md") {
    if (docType !== INDEX_DOC_TYPE) {
      findings.push(
        `${rel(path)}: doc_type \`${docType}\` invalid for an index — expected \`${INDEX_DOC_TYPE}\``,
      );
    }
  } else if (docType !== ADR_DOC_TYPE) {
    findings.push(
      `${rel(path)}: doc_type \`${docType}\` invalid for an ADR — expected \`${ADR_DOC_TYPE}\``,
    );
    findings.push(`  To fix: set \`doc_type: ${ADR_DOC_TYPE}\` in the frontmatter.`);
  }
}
checkIndexCoverage(
  ADR_DIR,
  adrFiles.filter((f) => f !== "README.md"),
);

// --- Specs: content docs use the spec vocabulary, README is the index. ---
const specFiles = topLevelMarkdown(SPEC_DIR);
const specDocTypes = new Map();
for (const file of specFiles) {
  const path = join(SPEC_DIR, file);
  const docType = docTypeOf(path);
  if (docType === undefined) {
    continue;
  }
  specDocTypes.set(file, docType);
  if (file === "README.md") {
    if (docType !== INDEX_DOC_TYPE) {
      findings.push(
        `${rel(path)}: doc_type \`${docType}\` invalid for an index — expected \`${INDEX_DOC_TYPE}\``,
      );
    }
    continue;
  }
  if (!SPEC_CONTENT_DOC_TYPES.has(docType)) {
    findings.push(
      `${rel(path)}: doc_type \`${docType}\` not in the spec vocabulary (${[...SPEC_CONTENT_DOC_TYPES].join(", ")})`,
    );
    findings.push(
      `  To fix: pick the \`doc_type:\` that matches the doc's role in docs/spec/README.md.`,
    );
  }
  if (NOT_CURRENT_CONTRACT.has(file) && docType === "current-contract") {
    findings.push(
      `${rel(path)}: doc_type \`current-contract\` is wrong for a historical/rationale doc`,
    );
    findings.push(
      `  To fix: this doc describes prior art / a dormant primitive, not the live protocol — give it a non-current-contract \`doc_type:\` (e.g. historical, rationale).`,
    );
  }
}
const specBody = checkIndexCoverage(
  SPEC_DIR,
  specFiles.filter((f) => f !== "README.md"),
);

// Section/metadata coherence: every spec doc must be listed under the
// README heading that matches its `doc_type`. The general index coverage
// above proves each file is linked once; this pass proves it is routed to
// the section its metadata declares.
if (specBody !== null) {
  const specSections = sectionsByH2(specBody);
  const sectionOfFile = new Map();
  for (const [heading, lines] of specSections) {
    for (const file of localMarkdownLinks(lines.join("\n"))) {
      if (!sectionOfFile.has(file)) {
        sectionOfFile.set(file, heading);
      }
    }
  }
  for (const [file, docType] of specDocTypes) {
    const expectedSection = SPEC_SECTION_BY_DOC_TYPE.get(docType);
    if (expectedSection === undefined) {
      continue;
    }
    const section = sectionOfFile.get(file);
    if (section !== expectedSection) {
      const found = section === undefined ? "no section" : `"${section}"`;
      findings.push(
        `docs/spec/README.md: ${file} has doc_type \`${docType}\` but is listed under ${found}, not "${expectedSection}"`,
      );
      findings.push(
        `  To fix: move the link to ${file} under "${expectedSection}", or correct its \`doc_type:\`.`,
      );
    }
  }
}

if (findings.length > 0) {
  for (const f of findings) {
    console.error(f);
  }
  console.error(`\n${findings.length} finding(s).`);
  process.exit(1);
}
console.log("docs taxonomy OK — doc_type vocabulary + spec/ADR index coverage verified");
