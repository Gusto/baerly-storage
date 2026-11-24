/**
 * Build the bench fixtures locally and deterministically.
 *
 *   pnpm bench:tree-fold-cpu:fixtures [tenant...]
 *
 * Writes `out/fixtures/<tenant>.json` (`{ key: text }`: every node, every
 * log entry and the head) and `out/manifest.json` (sizes and the SHA-256 of
 * each file). Synthetic data only: random UUID-shaped `_id`s and hex
 * padding from a seeded PRNG.
 *
 * The tree is the canonical tree of the rows at the production layout under
 * a fixed chunk salt, sealed under {@link FIXTURE_ATTEMPT}, with the head at
 * floor 0 and `tail_hint` 0, so a tick reads the log dense up to the
 * `knownTail` it is given. The tail is {@link TAIL_ENTRIES} scattered
 * changes that keep the row count and document bytes: delete, insert a
 * fresh `_id` of the deleted row's size, shrink one row, grow another by
 * the same amount. Consecutive targets land far apart in key order, so a
 * tick's changes touch many leaves.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DocumentData,
  encodeJsonBytes,
  type LogEntry,
  logObjectKey,
  sha256Hex,
} from "@baerly/protocol";
import { buildTree, sealTree } from "../../packages/server/src/tree/build.ts";
import { DEFAULT_TREE_CONFIG } from "../../packages/server/src/tree/layout.ts";
import { canonicalDocument } from "../../packages/server/src/tree/node-codec.ts";
import { logStateCurrentJson } from "../../tests/fixtures/log-state.ts";
import { TREE_TEST_CHUNK_SALT, testChunkKey } from "../../tests/fixtures/tree-chunk-salt.ts";
import { runAsCliEntrypoint } from "../measurement/cli-entrypoint.ts";
import {
  COLLECTION,
  collectionPrefix,
  FIXTURE_ATTEMPT,
  type FixtureManifest,
  FIXTURES,
  type FixtureSpec,
  fixtureByTenant,
  headKey,
  TAIL_ENTRIES,
} from "./cells.ts";

/** A small deterministic PRNG (mulberry32). */
class Rng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  hex(chars: number): string {
    let out = "";
    while (out.length < chars) {
      out += Math.floor(this.next() * 0x1_0000_0000)
        .toString(16)
        .padStart(8, "0");
    }
    return out.slice(0, chars);
  }

  /** A random ID in the 8-4-4-4-12 UUID shape. */
  id(): string {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}

/** Canonical bytes of `{"_id":<id>,"p":""}` for a 36-character `id`. */
const DOC_ENVELOPE_BYTES = 53;

/** A document of exactly `bytes` canonical bytes. */
const documentOf = (id: string, bytes: number, rng: Rng): DocumentData => ({
  _id: id,
  p: rng.hex(bytes - DOC_ENVELOPE_BYTES),
});

/** The tail's row changes over `ids` (sorted); see the module comment. */
const tailChanges = (
  ids: readonly string[],
  docBytes: number,
  length: number,
  rng: Rng,
): { id: string; doc: DocumentData | null }[] => {
  const live = [...ids];
  const sizes = new Map(ids.map((id) => [id, docBytes]));
  const delta = Math.floor((docBytes - DOC_ENVELOPE_BYTES) / 4);
  let j = 0;
  let lastDeleted = docBytes;
  let shrunk = 0;
  const pick = (): number => {
    j += 1;
    return Math.floor(((j * 0.618_033_988_749_895) % 1) * live.length);
  };
  const out: { id: string; doc: DocumentData | null }[] = [];
  for (let step = 0; step < length; step++) {
    const index = pick();
    const id = live[index]!;
    switch (step % 4) {
      case 0: {
        live.splice(index, 1);
        lastDeleted = sizes.get(id)!;
        sizes.delete(id);
        out.push({ id, doc: null });
        break;
      }
      case 1: {
        let fresh = rng.id();
        while (sizes.has(fresh)) {
          fresh = rng.id();
        }
        const at = live.findIndex((other) => other > fresh);
        live.splice(at === -1 ? live.length : at, 0, fresh);
        sizes.set(fresh, lastDeleted);
        out.push({ id: fresh, doc: documentOf(fresh, lastDeleted, rng) });
        break;
      }
      case 2: {
        const size = sizes.get(id)!;
        shrunk = Math.min(delta, size - DOC_ENVELOPE_BYTES);
        sizes.set(id, size - shrunk);
        out.push({ id, doc: documentOf(id, size - shrunk, rng) });
        break;
      }
      default: {
        const size = sizes.get(id)! + shrunk;
        sizes.set(id, size);
        out.push({ id, doc: documentOf(id, size, rng) });
      }
    }
  }
  return out;
};

export interface BuiltFixture {
  /** Every object, key to UTF-8 text, in a fixed order. */
  readonly objects: ReadonlyMap<string, string>;
  readonly manifest: Omit<FixtureManifest, "file" | "sha256">;
}

/** Build `spec`'s fixture with a tail of `tailEntries` changes. */
export const buildFixture = async (
  spec: FixtureSpec,
  tailEntries: number = TAIL_ENTRIES,
): Promise<BuiltFixture> => {
  const rng = new Rng(spec.rows * 31 + spec.docBytes);
  const prefix = collectionPrefix(spec.tenant);
  const idSet = new Set<string>();
  while (idSet.size < spec.rows) {
    idSet.add(rng.id());
  }
  const ids = [...idSet].toSorted();
  const docs = ids.map((id) => canonicalDocument(documentOf(id, spec.docBytes, rng), "base row"));
  const plan = await buildTree(docs, await testChunkKey(), DEFAULT_TREE_CONFIG);
  const sealed = await sealTree(plan, { prefix, attempt: FIXTURE_ATTEMPT, floor: 0 });
  const root = sealed.root!;
  const depth = sealed.levels.length - 1;
  if (depth !== spec.depth) {
    throw new Error(`${spec.tenant}: built depth ${depth}, expected ${spec.depth}`);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const objects = new Map<string, string>();
  let nodes = 0;
  for (const level of sealed.levels) {
    for (const node of level) {
      objects.set(node.key, decoder.decode(node.bytes));
      nodes += 1;
    }
  }
  const live = new Set(ids);
  for (const [seq, { id, doc }] of tailChanges(ids, spec.docBytes, tailEntries, rng).entries()) {
    let op: LogEntry["op"] = "D";
    if (doc === null) {
      live.delete(id);
    } else {
      op = live.has(id) ? "U" : "I";
      live.add(id);
    }
    const entry = {
      lsn: `lsn-${seq}`,
      commit_ts: "2026-01-01T00:00:00.000Z",
      op,
      collection: COLLECTION,
      doc_id: id,
      session: "ssn001",
      seq,
      ...(doc !== null && { after: doc }),
    };
    objects.set(logObjectKey(prefix, seq), decoder.decode(encodeJsonBytes(entry)));
  }
  const head = {
    ...logStateCurrentJson({
      log_seq_start: 0,
      tail_hint: 0,
      snapshot_rows: root.summary.rows,
      snapshot_bytes: root.summary.bytes,
    }),
    proto_tree: { root: root.key, attempt: FIXTURE_ATTEMPT, chunk_salt: TREE_TEST_CHUNK_SALT },
  };
  objects.set(headKey(spec.tenant), JSON.stringify(head));
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const text of objects.values()) {
    bytes += encoder.encode(text).byteLength;
  }
  return {
    objects,
    manifest: {
      tenant: spec.tenant,
      docBytes: spec.docBytes,
      rows: root.summary.rows,
      depth,
      treeBytes: root.summary.bytes,
      levelNodes: sealed.levels.map((level) => level.length),
      nodes,
      tailEntries,
      objects: objects.size,
      bytes,
    },
  };
};

/** The fixture file's text: one JSON object, keys in build order. */
export const fixtureText = (objects: ReadonlyMap<string, string>): string =>
  JSON.stringify(Object.fromEntries(objects));

const here = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = join(here, "out");

const main = async (): Promise<number> => {
  const tenants = process.argv.slice(2);
  const specs =
    tenants.length === 0
      ? FIXTURES
      : tenants.map((t) => {
          const spec = fixtureByTenant(t);
          if (spec === undefined) {
            throw new Error(`unknown tenant ${t}`);
          }
          return spec;
        });
  mkdirSync(join(OUT_DIR, "fixtures"), { recursive: true });
  // Rebuilding some tenants keeps the others' manifest entries.
  const manifestPath = join(OUT_DIR, "manifest.json");
  const previous = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as FixtureManifest[])
    : [];
  const manifests = previous.filter((m) => !specs.some((s) => s.tenant === m.tenant));
  for (const spec of specs) {
    const built = await buildFixture(spec);
    const text = fixtureText(built.objects);
    const file = `${spec.tenant}.json`;
    writeFileSync(join(OUT_DIR, "fixtures", file), text);
    const sha256 = await sha256Hex(new TextEncoder().encode(text));
    manifests.push({ ...built.manifest, file, sha256 });
    const m = built.manifest;
    console.log(
      `${spec.tenant}: depth ${m.depth}, ${m.rows} rows, ${m.nodes} nodes (${m.levelNodes.join("/")}), ${m.objects} objects, ${(m.bytes / 1024 / 1024).toFixed(1)} MiB, sha256 ${sha256.slice(0, 12)}`,
    );
  }
  manifests.sort(
    (a, b) =>
      FIXTURES.findIndex((f) => f.tenant === a.tenant) -
      FIXTURES.findIndex((f) => f.tenant === b.tenant),
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifests, null, 2)}\n`);
  return 0;
};

await runAsCliEntrypoint(import.meta.url, main);
