import "fake-indexeddb/auto";
import { afterEach, describe, expect, test } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { createStore, set } from "idb-keyval";
import { MPS3, type MPS3Config } from "../../src/mps3";
import { resetMemoryStorage as reset, url } from "@baerly/protocol";

const baseConfig = (label: string, bucket: string): MPS3Config => ({
  label,
  pollFrequency: 60_000,
  minimizeListObjectsCalls: false,
  parser: new DOMParser(),
  defaultBucket: bucket,
  offlineStorage: true,
  adaptiveClock: false,
  s3Config: { endpoint: MPS3.MEMORY_ENDPOINT },
});

describe("Manifest.load labeled-recovery", () => {
  afterEach(() => {
    reset();
  });

  test("labeled restore replays content; never names manifest as content", async () => {
    // Crash recovery scenario: a writer survived long enough to PUT
    // content + label the queue entry, then died before `confirm` ran.
    // On next boot the operation queue replays the labeled entry.
    //
    // The legacy else-branch passed the manifest's own ref into
    // `updateContent` as if the manifest were a content key — leaving
    // `state.files[<bucket>/<manifestKey>]` populated. That's a bug:
    // the manifest is the file map, not an entry in it.
    //
    // After the fix, labeled-restore funnels through `putAllResolved` like a
    // fresh write — content-hashed, idempotent under the manifest-first
    // ordering landed in adcd7ae.
    const bucket = `lr-${Math.random().toString(36).slice(2, 8)}`;
    const label = "default";
    const manifestKey = "manifest.json";
    const contentRef = { bucket, key: "foo" };
    const manifestRef = { bucket, key: manifestKey };

    // Seed the per-manifest IDB store the way `OperationQueue.propose` +
    // `OperationQueue.label` would have, mid-PUT: one labeled write
    // pointing at content, no `confirm` ever ran.
    const dbName = `mps3-${label}-${bucket}-${manifestKey}`;
    const store = createStore(dbName, "v0");
    await set(
      "write-000001",
      [[JSON.stringify(contentRef), { v: 1 }]],
      store,
    );
    await set("label-1", "stale-version-id", store);

    // Boot a fresh MPS3 against the same label/bucket. `getOrCreateManifest`
    // wires up `manifest.load(db)`, which calls `operationQueue.restore`
    // and replays the labeled entry through `Manifest.load`'s scheduler.
    const reader = new MPS3(baseConfig(label, bucket));

    // `get` drives the manifest poll (`getLatest`). Settle the labeled
    // replay and the resulting poll, then assert state shape.
    expect(await reader.get(contentRef)).toEqual({ v: 1 });

    // Poke at internals — the bug shows up structurally as a `files`
    // entry under the manifest's own URL. The public surface would
    // route that through `getVersion(manifestRef)`, but that goes
    // through `getLatest()`, so reach for the same source of truth.
    const manifest = reader.getOrCreateManifest(manifestRef);
    const state = await manifest.syncer.getLatest();
    expect(Object.keys(state.files)).not.toContain(url(manifestRef));
    expect(state.files[url(contentRef)]).toBeDefined();

    reader.shutdown();
  });
});
