import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { logObjectKey, type Storage } from "@baerly/protocol";
import { snapshotKey } from "../../../packages/server/src/snapshot.ts";

// The capture tool is the single owner of this on-disk contract. Restating any
// of it here would let producer and reader drift silently, so the reader
// imports both the manifest types and the corpus-relative path rule the
// producer validated every manifest entry against.
export type {
  Stage0CompatibilityManifest,
  Stage0FixtureContract,
  Stage0HashBinding,
} from "../../../scripts/freeze-fold-stage0-compatibility.mjs";

import {
  assertCorpusRelativePath,
  type Stage0CompatibilityManifest,
  type Stage0FixtureContract,
  type Stage0HashBinding,
} from "../../../scripts/freeze-fold-stage0-compatibility.mjs";

/** Absolute path to the frozen corpus root. */
export const FOLD_STAGE0_PRE_CHANGE_ROOT: string = fileURLToPath(
  new URL("./pre-change/", import.meta.url),
);

/** Study ID of the promoted evidence record for this corpus. */
export const FOLD_STAGE0_STUDY_ID = "compat-freeze-01bdd298ac19" as const;

/** The commit the corpus was captured from. Constant, never re-derived. */
export const FOLD_STAGE0_FROZEN_SUBJECT_COMMIT =
  "01bdd298ac19826e8141fe67cdfd3b62b4dcdd5e" as const;

const assertContainedFixturePath = (relPath: string): string => {
  // String rule first, owned by the capture tool. The resolved-prefix check
  // below is a second, independent belt: it catches anything the string rule
  // misses once the platform separator is in play.
  assertCorpusRelativePath(relPath);
  const absolute = resolve(FOLD_STAGE0_PRE_CHANGE_ROOT, ...relPath.split("/"));
  const root = resolve(FOLD_STAGE0_PRE_CHANGE_ROOT);
  if (absolute === root || !absolute.startsWith(`${root}${sep}`)) {
    throw new Error(`frozen fixture path escapes corpus root: ${JSON.stringify(relPath)}`);
  }
  return absolute;
};

/** Parses `manifest.json`. Throws on schema mismatch. */
export const loadStage0CompatibilityManifest = async (): Promise<Stage0CompatibilityManifest> => {
  const raw: unknown = JSON.parse(
    await readFile(resolve(FOLD_STAGE0_PRE_CHANGE_ROOT, "manifest.json"), "utf8"),
  );
  if (
    raw === null ||
    typeof raw !== "object" ||
    !("schema" in raw) ||
    raw.schema !== "baerly.fold-stage0-compatibility/v1"
  ) {
    throw new Error("frozen Stage 0 compatibility manifest has an unsupported schema");
  }
  return raw as Stage0CompatibilityManifest;
};

/** Raw, unnormalized bytes of one manifest-relative fixture. */
export const readFrozenFixtureBytes = async (relPath: string): Promise<Uint8Array> =>
  readFile(assertContainedFixturePath(relPath));

/** Filter helper so consumers never hard-code the directory layout. */
export const frozenFixturesByContract = (
  manifest: Stage0CompatibilityManifest,
  contract: Stage0FixtureContract,
): readonly Stage0HashBinding[] => manifest.files.filter((file) => file.contract === contract);

/** Declarative description of one synthetic collection prefix. */
export interface FrozenPrefixSeedOptions {
  /** e.g. `"app/tenant/tickets"`. No trailing slash. */
  readonly manifestPrefix: string;
  /** Manifest-relative path of a `current/` fixture. Required. */
  readonly current: string;
  /** Manifest-relative path of a `snapshot/` fixture, or `null`. */
  readonly snapshot: string | null;
  /** Log objects to seed, by sequence number. */
  readonly logs: readonly { readonly seq: number; readonly fixture: string }[];
}

interface FrozenSnapshotBody {
  readonly min_seq: number;
  readonly max_seq: number;
}

const bindingFor = (manifest: Stage0CompatibilityManifest, relPath: string): Stage0HashBinding => {
  const binding = manifest.files.find((file) => file.path === relPath);
  if (binding === undefined) {
    throw new Error(`frozen fixture is absent from manifest: ${relPath}`);
  }
  return binding;
};

/** Materializes one prefix as `storageKey -> raw bytes`. */
export const buildFrozenPrefixSeed = async (
  options: FrozenPrefixSeedOptions,
): Promise<ReadonlyMap<string, Uint8Array>> => {
  if (options.manifestPrefix.length === 0 || options.manifestPrefix.endsWith("/")) {
    throw new Error("manifestPrefix must be non-empty and have no trailing slash");
  }
  const manifest = await loadStage0CompatibilityManifest();
  bindingFor(manifest, options.current);
  const seed = new Map<string, Uint8Array>();
  seed.set(`${options.manifestPrefix}/current.json`, await readFrozenFixtureBytes(options.current));

  if (options.snapshot !== null) {
    const binding = bindingFor(manifest, options.snapshot);
    const bytes = await readFrozenFixtureBytes(options.snapshot);
    const body = JSON.parse(new TextDecoder().decode(bytes)) as FrozenSnapshotBody;
    seed.set(
      snapshotKey(options.manifestPrefix, body.min_seq, body.max_seq, binding.sha256),
      bytes,
    );
  }

  for (const log of options.logs) {
    bindingFor(manifest, log.fixture);
    seed.set(
      logObjectKey(options.manifestPrefix, log.seq),
      await readFrozenFixtureBytes(log.fixture),
    );
  }
  return seed;
};

/** Convenience: `buildFrozenPrefixSeed` then `storage.put` for each entry. */
export const seedStorageFromFrozenPrefix = async (
  storage: Storage,
  options: FrozenPrefixSeedOptions,
): Promise<void> => {
  for (const [key, bytes] of await buildFrozenPrefixSeed(options)) {
    await storage.put(key, bytes, { contentType: "application/json" });
  }
};
