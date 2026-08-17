import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closureFiles, measureMinGz, measureRawGz } from "./bundle-measure.ts";
import { spawnQuiet } from "./lib/quiet-spawn.mjs";

/** A measured size axis. */
export type Axis = "raw" | "gz" | "minGz";

/** Growth allowance and gated axes for a class of entry. */
export interface TierPolicy {
  /** Fractional growth allowed before the gate trips, e.g. 0.02 for 2%. */
  pct: number;
  /** Which axes this tier gates. */
  axes: readonly Axis[];
}

export interface SnapshotPolicy {
  /**
   * Absolute floor on the delta allowance. Binds only where `pct * baseline`
   * falls below it — on the min-gz axis of the smallest entries. Build output
   * is bit-for-bit deterministic (verified across three builds), so this
   * absorbs no noise; it exists purely to keep a 2 KB entry off a 45-byte
   * hair trigger.
   */
  floorBytes: number;
  tiers: Record<string, TierPolicy>;
}

export interface SnapshotEntry {
  /** Key into `SnapshotPolicy.tiers`. */
  tier: string;
  raw?: number;
  gz?: number;
  minGz?: number;
  /**
   * Absolute limits. Unlike the delta gate these cannot be regenerated away:
   * `--write` refuses to cross one, so raising it is a deliberate hand edit.
   *
   * Reserved for a bound that encodes a STRUCTURAL FACT rather than a
   * measurement — see `app-config.js`, whose ceiling asserts the entry has no
   * runtime closure at all. A ceiling parked a round number above whatever an
   * entry happens to weigh today encodes nothing: it cannot be derived, cannot
   * be defended in review, and drifts with the measurement it was copied from.
   * Use the delta gate for creep, and a structural test for the composition
   * facts bytes cannot express.
   */
  hardCeiling?: Partial<Record<Axis, number>>;
  /** Why this entry is classified the way it is. Preserved across `--write`. */
  note: string;
}

export interface Snapshot {
  $comment?: string;
  policy: SnapshotPolicy;
  entries: Record<string, SnapshotEntry>;
}

/** A fresh measurement of one entry's closure. */
export interface Measured {
  raw: number;
  gz: number;
  minGz?: number;
}

export type Violation =
  | {
      kind: "delta";
      entry: string;
      axis: Axis;
      baseline: number;
      measured: number;
      limit: number;
    }
  | { kind: "ceiling"; entry: string; axis: Axis; ceiling: number; measured: number };

/** Bytes of growth allowed before the delta gate trips. */
export function deltaLimit(baseline: number, pct: number, floorBytes: number): number {
  return Math.max(baseline * pct, floorBytes);
}

/**
 * A ceiling violation is structural: it cannot be regenerated away, because
 * the number it crossed is a deliberate commitment rather than a measurement.
 * Mirrors the `--write`-blocking structural checks in check-version-matrix.ts.
 */
export function blocksWrite(v: Violation): boolean {
  return v.kind === "ceiling";
}

/**
 * Compare a fresh measurement against the committed snapshot.
 *
 * Reports EVERY violation rather than stopping at the first, so one over-budget
 * axis cannot mask another and force a second round trip.
 */
export function compareSnapshot(
  snapshot: Snapshot,
  measured: Record<string, Measured>,
): Violation[] {
  const violations: Violation[] = [];
  for (const [entry, spec] of Object.entries(snapshot.entries)) {
    const tier = snapshot.policy.tiers[spec.tier];
    if (!tier) {
      throw new Error(
        `bundle-sizes: entry "${entry}" declares unknown tier "${spec.tier}" (known: ${Object.keys(
          snapshot.policy.tiers,
        ).join(", ")})`,
      );
    }
    const now = measured[entry];
    if (!now) {
      throw new Error(
        `bundle-sizes: snapshot lists "${entry}" but it was not measured — was it removed from the build?`,
      );
    }
    for (const axis of tier.axes) {
      const baseline = spec[axis];
      const current = now[axis];
      if (baseline === undefined || current === undefined) {
        continue;
      }
      const limit = deltaLimit(baseline, tier.pct, snapshot.policy.floorBytes);
      if (current - baseline > limit) {
        violations.push({ kind: "delta", entry, axis, baseline, measured: current, limit });
      }
    }
    for (const [axis, ceiling] of Object.entries(spec.hardCeiling ?? {})) {
      const current = now[axis as Axis];
      if (current !== undefined && ceiling !== undefined && current > ceiling) {
        violations.push({
          kind: "ceiling",
          entry,
          axis: axis as Axis,
          ceiling,
          measured: current,
        });
      }
    }
  }
  return violations;
}

const SNAPSHOT_PATH = fileURLToPath(new URL("../bundle-sizes.json", import.meta.url));
const PACKAGE_JSON_PATH = fileURLToPath(new URL("../package.json", import.meta.url));

/** Every published subpath's entry point, as a `dist/`-relative filename. */
export function publishedEntries(): string[] {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
    publishConfig?: { exports?: Record<string, { import?: string }> };
  };
  return Object.values(pkg.publishConfig?.exports ?? {})
    .map((c) => c.import)
    .filter((i): i is string => !!i && i.endsWith(".js"))
    .map((i) => i.replace(/^\.\/dist\//, ""));
}

/**
 * Published entries the snapshot does not name.
 *
 * The snapshot is the gate's work list — `measureSnapshotEntries` iterates it
 * and nothing else — so an entry missing from it is not gated leniently, it is
 * not gated at all. Rolldown emits it, consumers can import it, and no axis is
 * ever measured.
 *
 * `--write` cannot clear this: it only refreshes entries that already exist.
 * Adding one takes a `tier` and a `note`, which are hand-authored judgements.
 */
export function unmeasuredPublishedEntries(snapshot: Snapshot): string[] {
  return publishedEntries().filter((entry) => !(entry in snapshot.entries));
}

/** A tier-gated axis the snapshot carries no baseline for. */
export interface UngatedAxis {
  entry: string;
  axis: Axis;
}

/**
 * Tier-gated axes with no committed baseline.
 *
 * `compareSnapshot` skips an axis whose baseline is `undefined`, because it
 * cannot tell "not yet measured" apart from "this tier does not gate it". So
 * an entry present in the snapshot but carrying no numbers is not gated
 * leniently, it is not gated at all: it can grow without bound and every run
 * still reports `ok`.
 *
 * `unmeasuredPublishedEntries` does not catch this — the entry IS in the
 * snapshot. And the hand-add workflow produces exactly this state, since
 * adding an entry means writing a `tier` and a `note` and leaving the
 * measurements to a later `--write`. That window has to close before the next
 * commit rather than whenever someone next remembers to regenerate.
 */
export function ungatedAxes(snapshot: Snapshot): UngatedAxis[] {
  const out: UngatedAxis[] = [];
  for (const [entry, spec] of Object.entries(snapshot.entries)) {
    for (const axis of snapshot.policy.tiers[spec.tier]?.axes ?? []) {
      if (spec[axis] === undefined) {
        out.push({ entry, axis });
      }
    }
  }
  return out;
}

/**
 * The committed snapshot. Exported so the CLI and the tests gate the same
 * bytes: two call sites resolving the path independently can silently drift
 * onto different files, and the one that reads the wrong file passes.
 */
export function loadSnapshot(): Snapshot {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Snapshot;
}

/** Which axes an entry needs measured, given its tier and any hard ceilings. */
function axesFor(snapshot: Snapshot, spec: SnapshotEntry): readonly Axis[] {
  const tierAxes = snapshot.policy.tiers[spec.tier]?.axes ?? [];
  return [...new Set([...tierAxes, ...Object.keys(spec.hardCeiling ?? {})] as Axis[])];
}

/** Measure every entry the snapshot names, skipping axes nothing consumes. */
export async function measureSnapshotEntries(
  snapshot: Snapshot,
): Promise<Record<string, Measured>> {
  const out: Record<string, Measured> = {};
  for (const [entry, spec] of Object.entries(snapshot.entries)) {
    const files = closureFiles(entry);
    const { raw, gz } = measureRawGz(files);
    const needsMinGz = axesFor(snapshot, spec).includes("minGz");
    out[entry] = { raw, gz, ...(needsMinGz ? { minGz: await measureMinGz(files) } : {}) };
  }
  return out;
}

/**
 * How an axis is spelled in output. The `minGz` key is a JSON field name; every
 * line a human or an agent reads says `min-gz`, so the two never have to be
 * recognised as the same axis.
 */
const AXIS_LABEL: Record<Axis, string> = { raw: "raw", gz: "gz", minGz: "min-gz" };

/**
 * The gate's failure output. Exported so its shape is pinned by test: a green
 * run never reaches it, so nothing else exercises the one text an author is
 * guaranteed to read.
 */
export function formatViolation(v: Violation, floorBytes: number): string {
  const axis = AXIS_LABEL[v.axis];
  if (v.kind === "ceiling") {
    return [
      `FAIL ${v.entry} ${axis} ${v.measured} exceeds HARD CEILING ${v.ceiling} (+${
        v.measured - v.ceiling
      })`,
      `     Hard ceilings are product commitments, not measurements.`,
      `     Shrink the closure. \`--write\` will NOT clear this.`,
    ].join("\n");
  }
  const pct = (((v.measured - v.baseline) / v.baseline) * 100).toFixed(1);
  return [
    `FAIL ${v.entry} ${axis} ${v.baseline} -> ${v.measured} (+${
      v.measured - v.baseline
    }, +${pct}%) exceeds max(tier%, ${floorBytes}B)`,
    `     If intended: \`pnpm bundle-sizes --write\`, and say why in the commit message.`,
    `     Do NOT trim JSDoc, comments, or error text to fit — those ship`,
    `     un-stripped in raw/gz but vanish under a consumer's minifier.`,
  ].join("\n");
}

/** `(+260,+0.2%)`, or `""` when the snapshot carries no baseline for the axis. */
function formatDelta(current: number, baseline: number | undefined): string {
  if (baseline === undefined) {
    return "";
  }
  const delta = current - baseline;
  const sign = delta >= 0 ? "+" : "";
  if (baseline === 0) {
    return `(${sign}${delta})`;
  }
  return `(${sign}${delta},${sign}${((delta / baseline) * 100).toFixed(1)}%)`;
}

/**
 * One line per entry for `--report`: measured size on each axis, and how far
 * that has moved from the committed baseline. The delta is the number a
 * rebaseline decision turns on, so it belongs next to the measurement rather
 * than a `git diff bundle-sizes.json` away.
 *
 * Whitespace-tokenizable — no spaces inside an axis group — because
 * `packages/cli/AGENTS.md` points agents at grepping this output.
 */
export function formatReportLine(entry: string, measured: Measured, spec: SnapshotEntry): string {
  const parts: string[] = [];
  for (const axis of ["raw", "gz", "minGz"] as const) {
    const current = measured[axis];
    if (current === undefined) {
      continue;
    }
    parts.push(`${AXIS_LABEL[axis]}=${current}${formatDelta(current, spec[axis])}`);
  }
  return `BUNDLE_SIZE ${entry} ${parts.join(" ")}`;
}

/**
 * Canonical key order, so an axis measured for the first time lands next to
 * its siblings instead of after `note`, and two regenerations of the same
 * build produce byte-identical files.
 *
 * Written as a literal rather than a key loop so the compiler checks it: a
 * required field dropped from the reconstruction is a type error here, where
 * a `Record<string, unknown>` accumulator would need a double assertion to
 * become a `SnapshotEntry` again and would let the omission through.
 */
function orderEntry(spec: SnapshotEntry): SnapshotEntry {
  const { tier, raw, gz, minGz, hardCeiling, note, ...rest } = spec;
  return {
    tier,
    ...(raw !== undefined && { raw }),
    ...(gz !== undefined && { gz }),
    ...(minGz !== undefined && { minGz }),
    ...(hardCeiling !== undefined && { hardCeiling }),
    note,
    // Anything the schema grows later still survives a regeneration.
    ...rest,
  };
}

/**
 * The snapshot as `--write` would commit it: measured axes refreshed,
 * hand-maintained `tier` / `hardCeiling` / `note` carried through untouched.
 *
 * Pure, and split out from the write so the rebaseline contract is testable
 * without a filesystem or an `oxfmt` subprocess. Only axes the entry's tier
 * (or a hard ceiling) actually gates are written, so a tooling-tier entry
 * never accumulates a `gz` baseline nothing reads.
 *
 * An entry with no measurement keeps its committed values. The CLI cannot
 * reach that case — `compareSnapshot` throws on it first — but silently
 * dropping a baseline is the one outcome that must not happen here.
 */
export function nextSnapshot(snapshot: Snapshot, measured: Record<string, Measured>): Snapshot {
  const entries: Record<string, SnapshotEntry> = {};
  for (const [entry, spec] of Object.entries(snapshot.entries)) {
    const now = measured[entry];
    const updated: SnapshotEntry = { ...spec };
    for (const axis of now ? axesFor(snapshot, spec) : []) {
      const value = now?.[axis];
      if (value !== undefined) {
        updated[axis] = value;
      }
    }
    entries[entry] = orderEntry(updated);
  }
  return { ...snapshot, entries };
}

function writeSnapshot(snapshot: Snapshot, measured: Record<string, Measured>): void {
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(nextSnapshot(snapshot, measured), null, 2)}\n`);
  // `JSON.stringify` never collapses a short array onto one line, oxfmt always
  // does — so an un-formatted write leaves the tree failing `pnpm verify`'s
  // `format:check` immediately after a legitimate rebaseline. Formatting here
  // keeps the file oxfmt-owned (so hand edits to `note` / `hardCeiling` are
  // formatted too) rather than exempting it from the repo-wide format gate.
  const formatted = spawnSync("pnpm", ["exec", "oxfmt", SNAPSHOT_PATH], { stdio: "inherit" });
  if (formatted.status !== 0) {
    throw new Error("bundle-sizes: oxfmt failed on the regenerated snapshot");
  }
}

async function runCli(): Promise<void> {
  const write = process.argv.includes("--write");
  const reportOnly = process.argv.includes("--report");

  // `--report` returns before the `--write` branch, so the combination would
  // otherwise print a report and silently drop the rebaseline the caller asked
  // for. Rejected rather than given a precedence, because either precedence
  // discards half of an explicit request. Checked before the build so the
  // typo costs no time.
  if (write && reportOnly) {
    console.error("FAIL --write and --report are mutually exclusive; run one, then the other.");
    process.exit(1);
  }

  if (!process.env["BAERLY_SKIP_BUILD"]) {
    // The rolldown build prints a ~150-line per-asset/chunk size table that
    // has no clean CLI suppress flag and is pure noise ahead of the size
    // report this command actually exists to print. spawnQuiet captures it
    // and only replays on failure — see scripts/lib/quiet-spawn.mjs.
    spawnQuiet("pnpm", ["run", "build"]);
  }

  const snapshot = loadSnapshot();

  // Before any mode does anything, including `--report`: a published entry
  // absent from the snapshot is unmeasurable, so every mode is reporting on an
  // incomplete set. This check lives here rather than only in the vitest suite
  // because the lefthook hook runs THIS, and adding a subpath touches
  // rolldown.config.ts — which is in the hook's glob. Leaving it test-only
  // would let the hook pass on exactly the change that introduces the gap,
  // with CI catching it a push later.
  const unmeasured = unmeasuredPublishedEntries(snapshot);
  if (unmeasured.length > 0) {
    console.error(`FAIL published entries absent from bundle-sizes.json: ${unmeasured.join(", ")}`);
    console.error(
      `     Nothing measures these. Add each with a \`tier\` and a \`note\`, then\n` +
        `     \`pnpm bundle-sizes --write\` to fill in the measurements.`,
    );
    process.exit(1);
  }

  // `--write` is the one mode allowed past this: filling in a missing baseline
  // is precisely what it does. Every other mode would otherwise print `ok` for
  // an entry the delta gate silently skips, which is how a hand-added entry
  // gets committed green and grows unbounded until someone regenerates.
  if (!write) {
    const ungated = ungatedAxes(snapshot);
    if (ungated.length > 0) {
      console.error(
        `FAIL no committed baseline on a tier-gated axis: ${ungated
          .map((u) => `${u.entry} ${AXIS_LABEL[u.axis]}`)
          .join(", ")}`,
      );
      console.error(
        `     The delta gate skips an axis it cannot compare, so nothing gates\n` +
          `     these. Run \`pnpm bundle-sizes --write\` to fill them in.`,
      );
      process.exit(1);
    }
  }

  const measured = await measureSnapshotEntries(snapshot);

  if (reportOnly) {
    for (const [entry, m] of Object.entries(measured)) {
      console.log(formatReportLine(entry, m, snapshot.entries[entry]!));
    }
    return;
  }

  const violations = compareSnapshot(snapshot, measured);
  const blocking = violations.filter(blocksWrite);
  const { floorBytes } = snapshot.policy;

  if (write) {
    if (blocking.length > 0) {
      console.error(blocking.map((v) => formatViolation(v, floorBytes)).join("\n\n"));
      console.error(
        `\nbundle-sizes: refusing to --write past ${blocking.length} hard-ceiling violation(s).`,
      );
      process.exit(1);
    }
    writeSnapshot(snapshot, measured);
    console.log("bundle-sizes: wrote bundle-sizes.json");
    return;
  }

  if (violations.length > 0) {
    console.error(violations.map((v) => formatViolation(v, floorBytes)).join("\n\n"));
    console.error(
      `\nbundle-sizes: ${violations.length} violation(s). Policy: docs/contributing/conventions/bundle-budgets.md`,
    );
    process.exit(1);
  }
  console.log(`bundle-sizes: ok (${Object.keys(measured).length} entries)`);
}

// Direct-invocation guard, matching scripts/check-version-matrix.ts. Compares
// resolved paths so importing this module from a test does not run the CLI.
const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  await runCli();
}
