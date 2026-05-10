import { afterEach, describe, expect, test } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { MPS3, type MPS3Config } from "../../src/mps3";
import { MPS3Error, resetMemoryStorage as reset } from "@baerly/protocol";

const baseConfig = (label: string, bucket: string): MPS3Config => ({
    label,
    minimizeListObjectsCalls: false,
    parser: new DOMParser(),
    defaultBucket: bucket,
    offlineStorage: false,
    adaptiveClock: false,
    s3Config: { endpoint: MPS3.MEMORY_ENDPOINT },
});

describe("putAllResolved partial failure (manifest-first ordering)", () => {
    afterEach(() => {
        reset();
    });

    test("reader sees committed content; missing content shows in-flight", async () => {
        // Manifest-first ordering invariants under partial content-PUT failure:
        // 1. The manifest commits before any content PUT.
        // 2. Content that succeeded is visible through the reader.
        // 3. Content that failed leaves an orphan manifest entry; the reader
        //    classifies it as in-flight and returns `undefined` rather than
        //    a stale or fabricated value.
        // 4. The pre-existing seed value is unaffected.
        //
        // Compare against the legacy content-first ordering, where partial
        // failure left unreferenced content and the manifest never advanced —
        // the failure mode swapped from "leak content nothing references"
        // to "leak identifiable orphan manifest entries the future Phase-6
        // sweeper will GC".
        const bucket = `pa-${Math.random().toString(36).slice(2, 8)}`;
        const writer = new MPS3(baseConfig("writer", bucket));

        // Seed a known-good manifest with a baseline value so a subsequent
        // failed putAll has a "before" state to compare against.
        await writer.put("seed", "before");

        // Wrap the writer's per-bucket Storage.put to fail the SECOND
        // CONTENT put during the multi-key putAll. Manifest entries
        // also flow through Storage.put — under manifest-first
        // ordering they hit a manifest-prefixed key (e.g.
        // `manifest.json@…`), so excluding `manifest.json` from the
        // counter selects content-only puts.
        const storage = writer.storageFor(bucket);
        const originalPut = storage.put.bind(storage);
        let contentPutCount = 0;
        storage.put = async (key, body, opts) => {
            if (!key.includes("manifest.json")) {
                contentPutCount++;
                if (contentPutCount === 2) {
                    // `InvalidConfig` is a permanent code — `S3HttpStorage.retry`
                    // short-circuits on it. A generic `Error` would be retried
                    // up to `S3_REQUEST_MAX_RETRIES` times and likely "self-heal"
                    // (the Nth-call counter would let later attempts through),
                    // hiding the bug we're trying to pin.
                    throw new MPS3Error(
                        "InvalidConfig",
                        "injected: content PUT failed mid-batch",
                    );
                }
            }
            return originalPut(key, body, opts);
        };

        await expect(
            writer.putAll(
                new Map<string, string>([
                    ["doc/a", "alpha"],
                    ["doc/b", "beta"],
                    ["doc/c", "gamma"],
                ]),
            ),
        ).rejects.toThrow();

        // A sibling reader against the same bucket reads through the
        // manifest. Under manifest-first ordering, the manifest committed
        // before any content PUT, so all three refs are referenced even
        // though the second content PUT failed.
        const reader = new MPS3(baseConfig("reader", bucket));

        // Seed value untouched by the failed batch.
        expect(await reader.get("seed")).toBe("before");

        // Successfully PUT content is visible.
        expect(await reader.get("doc/a")).toBe("alpha");
        expect(await reader.get("doc/c")).toBe("gamma");

        // The failed PUT (doc/b) leaves an orphan manifest entry pointing
        // at content that never landed. The reader returns `undefined`
        // (in-flight tolerance), not a fabricated value — and crucially
        // not the "deleted" semantic, which would be wrong here.
        expect(await reader.get("doc/b")).toBeUndefined();
    });
});
