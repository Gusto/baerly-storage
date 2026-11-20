// Build the bench's synthetic fixtures under Node, from the current tree.
//   pnpm bench:paid-memory:fixtures
// One fixture per cell (see cells.ts), from the same builder the Node fold
// benches use (`bench/lib/fold-fixture.ts`): a folded snapshot of
// rows x bytesPerDoc plus a live tail of full-post-image updates. Keys are
// moved under the cell's tenant. Writes out/fixtures/<tenant>/ and
// out/manifest.json; nothing here is committed (out/ is gitignored).
//
// Seeding happens here rather than in the Worker: building a 32 MiB snapshot
// inside an isolate would itself hit the memory wall the bench measures.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CurrentJson, decodeJsonBytes, encodeJsonBytes } from "@baerly/protocol";
import { FOLD_CURRENT_JSON_KEY, buildFixture } from "../lib/fold-fixture.ts";
import {
  CELLS,
  type CellManifest,
  type CellSpec,
  FIXTURE_TAIL,
  HARD_GC_INTERVAL,
  NATURAL_HEADROOM,
  currentJsonKey,
  tenantPrefix,
} from "./cells.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "out", "fixtures");
const BUILDER_PREFIX = "app/x/tenant/t/";
const MIB = 1024 * 1024;

/** Per-row snapshot bytes for a doc size, measured on a small build. */
const perRowBytes = async (bytesPerDoc: number): Promise<number> => {
  const probe = await buildFixture(1000, bytesPerDoc, 0);
  return probe.snapshotBytes / 1000;
};

/**
 * Rows for a target size, nudged down so the write at seq
 * `rows + FIXTURE_TAIL` does not cross a hard-GC boundary (a GC tick there
 * would pre-empt the fold).
 */
const rowsFor = (targetMiB: number, perRow: number): number => {
  let rows = Math.round((targetMiB * MIB) / perRow);
  while ((rows + FIXTURE_TAIL + 1) % HARD_GC_INTERVAL === 0) {
    rows -= 1;
  }
  return rows;
};

const rekey = (key: string, tenant: string): string => {
  if (!key.startsWith(BUILDER_PREFIX)) {
    throw new Error(`fixture key outside the builder prefix: ${key}`);
  }
  return tenantPrefix(tenant) + key.slice(BUILDER_PREFIX.length);
};

const docId = (i: number): string => `doc-${i.toString().padStart(8, "0")}`;

const buildCell = async (
  spec: CellSpec,
  rows: number,
  copyFrom: string | undefined,
): Promise<CellManifest> => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // The natural cell's tail length depends on the real mean entry size, so
  // it is built in two steps: measure one entry, then build the full tail.
  let tail = FIXTURE_TAIL;
  if (spec.kind === "natural") {
    const probe = await buildFixture(rows, spec.bytesPerDoc, FIXTURE_TAIL);
    const mean = await meanLogEntryBytes(probe.storage);
    tail = Math.floor(probe.snapshotBytes / mean) - NATURAL_HEADROOM;
  }
  const fx = await buildFixture(rows, spec.bytesPerDoc, tail);
  const head = decodeJsonBytes<CurrentJson>((await fx.storage.get(FOLD_CURRENT_JSON_KEY))!.body);
  const mean = await meanLogEntryBytes(fx.storage);
  let meanEntryBytes: number | undefined;
  if (spec.kind === "fold") {
    // FORCED trigger: the next write makes the tail FIXTURE_TAIL + 1
    // entries, so this mean puts the derived tail at or past the snapshot.
    meanEntryBytes = Math.ceil(fx.snapshotBytes / FIXTURE_TAIL);
  } else if (spec.kind === "natural") {
    // What a fold of these entries would have stamped.
    meanEntryBytes = Math.round(mean);
  }

  const dir = join(outDir, spec.tenant);
  mkdirSync(dir, { recursive: true });
  const small: Record<string, string> = {};
  let snapshotKey = "";
  for await (const { key } of fx.storage.list(BUILDER_PREFIX)) {
    const body = (await fx.storage.get(key))!.body;
    const newKey = rekey(key, spec.tenant);
    if (key === head.snapshot) {
      snapshotKey = newKey;
      if (copyFrom === undefined) {
        writeFileSync(join(dir, "snapshot.json"), body);
      }
    } else if (key === FOLD_CURRENT_JSON_KEY) {
      const next: CurrentJson = {
        ...head,
        snapshot: rekey(head.snapshot as string, spec.tenant),
        ...(meanEntryBytes !== undefined && { mean_entry_bytes: meanEntryBytes }),
      };
      small[newKey] = decoder.decode(encodeJsonBytes(next));
    } else {
      small[newKey] = decoder.decode(body);
    }
  }
  if (snapshotKey === "" || small[currentJsonKey(spec.tenant)] === undefined) {
    throw new Error(`${spec.tenant}: fixture is missing its snapshot or current.json`);
  }
  writeFileSync(join(dir, "small.json"), JSON.stringify(small));
  return {
    tenant: spec.tenant,
    kind: spec.kind,
    bytesPerDoc: spec.bytesPerDoc,
    rows,
    snapshotBytes: fx.snapshotBytes,
    snapshotKey,
    snapshotFile: join(copyFrom ?? spec.tenant, "snapshot.json"),
    ...(copyFrom !== undefined && { snapshotCopyFrom: copyFrom }),
    smallFile: join(spec.tenant, "small.json"),
    smallObjects: Object.keys(small).length,
    logSeqStart: head.log_seq_start,
    tailEntries: tail,
    ...(meanEntryBytes !== undefined && { meanEntryBytes }),
    docId: docId(Math.floor(rows / 2)),
  };
};

const meanLogEntryBytes = async (
  storage: Awaited<ReturnType<typeof buildFixture>>["storage"],
): Promise<number> => {
  let n = 0;
  let sum = 0;
  for await (const { key } of storage.list(`${BUILDER_PREFIX}manifests/`)) {
    if (key.includes("/log/")) {
      sum += (await storage.get(key))!.body.byteLength;
      n += 1;
    }
  }
  return sum / n;
};

const only = process.argv.slice(2);
const perRow = new Map<number, number>();
const manifests: CellManifest[] = [];
// The first cell of each (size, doc) pair owns the snapshot file; later cells
// with identical rows and doc size copy it Worker-side.
const owner = new Map<string, string>();
for (const spec of CELLS) {
  if (only.length > 0 && !only.includes(spec.tenant)) {
    continue;
  }
  if (!perRow.has(spec.bytesPerDoc)) {
    perRow.set(spec.bytesPerDoc, await perRowBytes(spec.bytesPerDoc));
  }
  const rows = rowsFor(spec.targetMiB, perRow.get(spec.bytesPerDoc)!);
  const shape = `${rows}x${spec.bytesPerDoc}`;
  const m = await buildCell(spec, rows, owner.get(shape));
  if (!owner.has(shape)) {
    owner.set(shape, spec.tenant);
  }
  manifests.push(m);
  console.log(
    `${m.tenant}: kind=${m.kind} rows=${m.rows} snapshot=${(m.snapshotBytes / MIB).toFixed(3)} MiB ` +
      `tail=${m.tailEntries} mean_entry_bytes=${m.meanEntryBytes ?? "unset"}`,
  );
}
writeFileSync(join(here, "out", "manifest.json"), `${JSON.stringify(manifests, null, 2)}\n`);
