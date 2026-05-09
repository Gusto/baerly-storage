import { afterEach, describe, expect, test } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { MPS3, type MPS3Config } from "../../src/mps3";
import { reset } from "../../src/memory-fetch";
import { MPS3Error } from "../../src/errors";
import type { FetchFn } from "../../src/s3-client-lite";

const baseConfig = (label: string, bucket: string): MPS3Config => ({
    label,
    pollFrequency: 60_000,
    minimizeListObjectsCalls: false,
    parser: new DOMParser(),
    defaultBucket: bucket,
    offlineStorage: false,
    adaptiveClock: false,
    s3Config: { endpoint: MPS3.MEMORY_ENDPOINT },
});

describe("_putAll partial failure", () => {
    afterEach(() => {
        reset();
    });

    test("manifest is not advanced when a content PUT fails mid-batch", async () => {
        const bucket = `pa-${Math.random().toString(36).slice(2, 8)}`;
        const writer = new MPS3(baseConfig("writer", bucket));

        // Seed a known-good manifest with a baseline value so a subsequent
        // failed putAll has a "before" state to compare against.
        await writer.put("seed", "before");

        // Wrap the writer's fetch to fail the SECOND PUT seen during the
        // multi-key putAll. The first content PUT succeeds; the second
        // rejects mid-batch. Manifest entries are also written via PUT so
        // we restrict the failure to PUTs against the content prefix only.
        const original = (writer.s3ClientLite as unknown as { fetch: FetchFn })
            .fetch;
        let contentPutCount = 0;
        (writer.s3ClientLite as unknown as { fetch: FetchFn }).fetch = async (
            url,
            init,
        ) => {
            if (init?.method === "PUT" && !url.includes("manifest.json")) {
                contentPutCount++;
                if (contentPutCount === 2) {
                    // `InvalidConfig` is a permanent code — `S3ClientLite.retry`
                    // short-circuits on it. A generic `Error` would be retried
                    // up to S3_REQUEST_MAX_RETRIES times and likely "self-heal"
                    // (the Nth-call counter would let later attempts through),
                    // hiding the bug we're trying to pin.
                    throw new MPS3Error(
                        "InvalidConfig",
                        "injected: content PUT failed mid-batch",
                    );
                }
            }
            return original(url, init);
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

        // A sibling reader against the same bucket must see neither
        // {doc/a, doc/b, doc/c} (none of the partial batch should be
        // visible through the manifest), and the seed value must be intact.
        const reader = new MPS3(baseConfig("reader", bucket));
        expect(await reader.get("seed")).toBe("before");
        expect(await reader.get("doc/a")).toBeUndefined();
        expect(await reader.get("doc/b")).toBeUndefined();
        expect(await reader.get("doc/c")).toBeUndefined();

        writer.shutdown();
        reader.shutdown();
    });
});
