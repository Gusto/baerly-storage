import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

/**
 * Exception-register checker (docs/contributing/conventions/supply-chain.md).
 *
 * `docs/contributing/exception-register.json` lists every deliberate loosening
 * of the install and audit policy. This script fails when
 *   - an entry is past its `expires` date,
 *   - a loosening exists in the repo with no register entry, or
 *   - an entry names a loosening that is gone (delete the entry with it).
 *
 * Detected loosenings:
 *   - in the root `pnpm-workspace.yaml` and every `examples/*` one:
 *     `audit.ignore` ids, `overrides` and `packageExtensions` keys,
 *     `allowBuilds: true` entries, `ignoreWorkspaceCycles`,
 *     `trustPolicyExclude` and `minimumReleaseAgeExclude`, and any strict
 *     setting that has drifted from its required value (reported as
 *     `weakened:<setting>`; see `STRICT_SETTINGS`);
 *   - `ignore` entries in `.github/dependabot.yml`;
 *   - zizmor ignore comments and config files under `.github/`.
 *
 * `pin` entries (an exact version pin held for policy reasons) are checked to
 * still exist but NOT discovered: most exact pins in a manifest are plain
 * reproducibility choices, so only a pin that Dependabot is told to skip
 * (an `ignore` entry) is detected, through that entry. `external` entries
 * (dashboard decisions such as Socket license accepts, a pnpm bug we are
 * waiting out) are checked for expiry only, since the repo cannot see them.
 */

export type ExceptionKind =
  | "audit-ignore"
  | "override"
  | "package-extension"
  | "setting"
  | "allow-build"
  | "dependabot-ignore"
  | "suppression"
  | "pin"
  | "external";

export type ExceptionEntry = {
  id: string;
  kind: ExceptionKind;
  /** Repo-relative files the loosening lives in. Empty for `external`. */
  files: string[];
  /** The advisory id, override key, package name, setting name, or literal pin text. */
  subject: string;
  reason: string;
  /** The condition under which the exception should be removed. */
  revisit: string;
  /** `YYYY-MM-DD`. Renew with a reason, or remove the loosening. */
  expires: string;
};

export type Loosening = {
  kind: Exclude<ExceptionKind, "pin" | "external">;
  file: string;
  subject: string;
};

const KINDS: ReadonlySet<string> = new Set<ExceptionKind>([
  "audit-ignore",
  "override",
  "package-extension",
  "setting",
  "allow-build",
  "dependabot-ignore",
  "suppression",
  "pin",
  "external",
]);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

type StrictCheck = (value: unknown) => boolean;

/**
 * Strict install settings and the value each must keep. A setting that drifts
 * (changed, or deleted where a bare default is not enough) is reported as
 * `weakened:<name>` and needs a register entry. `minimumReleaseAge` must stay
 * explicit because only an explicit value turns `minimumReleaseAgeStrict` on.
 */
export const STRICT_SETTINGS: Record<string, { check: StrictCheck; templates: boolean }> = {
  trustPolicy: { check: (v) => v === "no-downgrade", templates: true },
  minimumReleaseAge: { check: (v) => typeof v === "number" && v >= 1440, templates: true },
  blockExoticSubdeps: { check: (v) => v === true, templates: true },
  strictPeerDependencies: { check: (v) => v === true, templates: false },
  engineStrict: { check: (v) => v === true, templates: false },
  // pnpm defaults both of these to the safe value, so absence is fine.
  strictDepBuilds: { check: (v) => v === undefined || v === true, templates: true },
  dangerouslyAllowAllBuilds: { check: (v) => v === undefined || v === false, templates: true },
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Pull every loosening out of one parsed `pnpm-workspace.yaml`. */
export const detectLoosenings = (file: string, parsedWorkspace: unknown): Loosening[] => {
  const workspace = isRecord(parsedWorkspace) ? parsedWorkspace : {};
  const out: Loosening[] = [];
  const isRoot = file === "pnpm-workspace.yaml";
  for (const [name, { check, templates }] of Object.entries(STRICT_SETTINGS)) {
    if ((isRoot || templates) && !check(workspace[name])) {
      out.push({ kind: "setting", file, subject: `weakened:${name}` });
    }
  }
  const audit = workspace["audit"];
  if (isRecord(audit) && Array.isArray(audit["ignore"])) {
    for (const id of audit["ignore"]) {
      out.push({ kind: "audit-ignore", file, subject: String(id) });
    }
  }
  for (const [field, kind] of [
    ["overrides", "override"],
    ["packageExtensions", "package-extension"],
  ] as const) {
    const map = workspace[field];
    if (isRecord(map)) {
      for (const key of Object.keys(map)) {
        out.push({ kind, file, subject: key });
      }
    }
  }
  const allowBuilds = workspace["allowBuilds"];
  if (isRecord(allowBuilds)) {
    for (const [pkg, value] of Object.entries(allowBuilds)) {
      if (value === true) {
        out.push({ kind: "allow-build", file, subject: pkg });
      }
    }
  }
  if (workspace["ignoreWorkspaceCycles"] === true) {
    out.push({ kind: "setting", file, subject: "ignoreWorkspaceCycles" });
  }
  for (const name of ["trustPolicyExclude", "minimumReleaseAgeExclude"]) {
    const value = workspace[name];
    if (Array.isArray(value) ? value.length > 0 : value !== undefined) {
      out.push({ kind: "setting", file, subject: name });
    }
  }
  return out;
};

/** Every `ignore` entry in `dependabot.yml`: each one skips updates we would otherwise take. */
export const detectDependabotIgnores = (file: string, dependabot: unknown): Loosening[] => {
  const out: Loosening[] = [];
  const updates =
    isRecord(dependabot) && Array.isArray(dependabot["updates"]) ? dependabot["updates"] : [];
  for (const update of updates) {
    const ignores = isRecord(update) && Array.isArray(update["ignore"]) ? update["ignore"] : [];
    for (const ignore of ignores) {
      if (isRecord(ignore) && typeof ignore["dependency-name"] === "string") {
        out.push({ kind: "dependabot-ignore", file, subject: ignore["dependency-name"] });
      }
    }
  }
  return out;
};

/**
 * zizmor suppressions: a `# zizmor: ignore[...]` comment or a zizmor config
 * file. (CodeQL default setup has no in-repo suppression files; a CodeQL
 * config under `.github/codeql/` would be flagged here too.)
 */
export const detectSuppressions = (file: string, text: string): Loosening[] => {
  const isConfig = /(^|\/)(zizmor\.ya?ml|codeql\/[^/]+\.ya?ml)$/.test(file);
  const hasComment = /#\s*zizmor:\s*ignore/.test(text);
  return isConfig || hasComment ? [{ kind: "suppression", file, subject: file }] : [];
};

/** Structural problems with the register itself (shape, dates, duplicates). */
export const validateRegister = (register: unknown, today: string): string[] => {
  const problems: string[] = [];
  if (!Array.isArray(register)) {
    return ["the register must be a JSON array of entries"];
  }
  const ids = new Set<string>();
  for (const [index, raw] of register.entries()) {
    const label = isRecord(raw) && typeof raw["id"] === "string" ? raw["id"] : `entry #${index}`;
    if (!isRecord(raw)) {
      problems.push(`${label}: not an object`);
      continue;
    }
    for (const field of ["id", "kind", "subject", "reason", "revisit", "expires"]) {
      if (typeof raw[field] !== "string" || raw[field] === "") {
        problems.push(`${label}: missing or empty "${field}"`);
      }
    }
    if (!Array.isArray(raw["files"]) || !raw["files"].every((f) => typeof f === "string")) {
      problems.push(`${label}: "files" must be an array of repo-relative paths`);
    }
    const kind = raw["kind"];
    if (typeof kind === "string" && !KINDS.has(kind)) {
      problems.push(`${label}: unknown kind "${kind}"`);
    }
    if (kind !== "external" && Array.isArray(raw["files"]) && raw["files"].length === 0) {
      problems.push(`${label}: "files" must name at least one file`);
    }
    const expires = raw["expires"];
    if (typeof expires === "string" && expires !== "") {
      if (!DATE.test(expires) || Number.isNaN(Date.parse(expires))) {
        problems.push(`${label}: "expires" must be a YYYY-MM-DD date`);
      } else if (expires < today) {
        problems.push(
          `${label}: expired on ${expires}. Remove the loosening, or renew the entry with a reason.`,
        );
      }
    }
    if (typeof raw["id"] === "string") {
      if (ids.has(raw["id"])) {
        problems.push(`${label}: duplicate id`);
      }
      ids.add(raw["id"]);
    }
  }
  return problems;
};

/**
 * Cross-check detected loosenings against the register. `pinExists` answers
 * whether a `pin` entry's literal text is still present in its file.
 */
export const collectViolations = (
  register: ExceptionEntry[],
  loosenings: Loosening[],
  pinExists: (file: string, text: string) => boolean,
  today: string,
): string[] => {
  const problems = validateRegister(register, today);
  if (problems.some((p) => p.includes("must be a JSON array"))) {
    return problems;
  }
  const entries = register.filter((e) => typeof e?.kind === "string" && Array.isArray(e.files));
  const covers = (e: ExceptionEntry, l: Loosening) =>
    e.kind === l.kind && e.subject === l.subject && e.files.includes(l.file);

  for (const l of loosenings) {
    if (!entries.some((e) => covers(e, l))) {
      problems.push(
        `unregistered loosening: ${l.kind} "${l.subject}" in ${l.file}. Add an entry to docs/contributing/exception-register.json (reason, revisit trigger, expiry), or remove the loosening.`,
      );
    }
  }
  for (const e of entries) {
    if (e.kind === "external") {
      continue;
    }
    for (const file of e.files) {
      if (e.kind === "pin") {
        if (!pinExists(file, e.subject)) {
          problems.push(
            `${e.id}: pin text ${JSON.stringify(e.subject)} is gone from ${file}. Remove the entry.`,
          );
        }
      } else if (!loosenings.some((l) => covers(e, l) && l.file === file)) {
        problems.push(
          `${e.id}: no ${e.kind} "${e.subject}" in ${file} any more. Remove the entry.`,
        );
      }
    }
  }
  return problems;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const workspaceFiles = (): string[] => {
  const files = ["pnpm-workspace.yaml"];
  for (const dir of readdirSync(join(repoRoot, "examples"), { withFileTypes: true })) {
    const rel = `examples/${dir.name}/pnpm-workspace.yaml`;
    if (dir.isDirectory() && existsSync(join(repoRoot, rel))) {
      files.push(rel);
    }
  }
  return files;
};

/** Every text file under `.github/` (workflows, actions, config). */
const githubFiles = (dir = ".github"): string[] =>
  readdirSync(join(repoRoot, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    return entry.isDirectory() ? githubFiles(rel) : [rel];
  });

const runCli = (): void => {
  const today = new Date().toISOString().slice(0, 10);
  const register = JSON.parse(
    readFileSync(join(repoRoot, "docs/contributing/exception-register.json"), "utf8"),
  ) as ExceptionEntry[];
  const loosenings: Loosening[] = [];
  for (const file of workspaceFiles()) {
    loosenings.push(
      ...detectLoosenings(file, parseYaml(readFileSync(join(repoRoot, file), "utf8"))),
    );
  }
  for (const file of githubFiles()) {
    const text = readFileSync(join(repoRoot, file), "utf8");
    loosenings.push(...detectSuppressions(file, text));
    if (file === ".github/dependabot.yml") {
      loosenings.push(...detectDependabotIgnores(file, parseYaml(text)));
    }
  }
  const problems = collectViolations(
    register,
    loosenings,
    (file, text) =>
      existsSync(join(repoRoot, file)) && readFileSync(join(repoRoot, file), "utf8").includes(text),
    today,
  );
  if (problems.length > 0) {
    console.error(`exceptions: ${problems.length} problem(s)`);
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  console.log(`exceptions: ok (${register.length} entries, ${loosenings.length} loosenings)`);
};

const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  runCli();
}
