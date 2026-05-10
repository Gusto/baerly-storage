import { afterEach, describe, expect, test, vi } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { MPS3 } from "../src/mps3";
import {
    S3HttpStorage,
    resetMemoryStorage as reset,
    S3_REQUEST_MAX_RETRIES,
    SESSION_ID_LENGTH,
    SYNCER_CLOCK_SKEW_MAX_RETRIES,
    uuid,
} from "@baerly/protocol";

describe("regressions (§9 bug-fix list)", () => {
    describe("retry bound (S3HttpStorage.retry)", () => {
        test("transient failures stop after a bounded number of attempts", async () => {
            vi.useFakeTimers();
            try {
                let attempts = 0;
                const fetchFn: typeof fetch = async (_input) => {
                    attempts++;
                    throw new Error("transient");
                };
                const storage = new S3HttpStorage({
                    endpoint: "http://test",
                    bucket: "b",
                    fetch: fetchFn,
                });
                const promise = storage.put("k", new TextEncoder().encode("{}"));
                // Surface unhandled rejection through the assertion below.
                promise.catch(() => {});
                await vi.runAllTimersAsync();
                await expect(promise).rejects.toThrow("transient");
                expect(attempts).toBe(S3_REQUEST_MAX_RETRIES + 1);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    // The legacy "non-JSON 5xx error body" regression (where a 5xx
    // HTML body could surface as `SyntaxError` because the legacy
    // fetch-based S3 client ran `JSON.parse` based on `Content-Type`)
    // is now structurally impossible: `S3HttpStorage` never parses
    // bodies, and
    // `MPS3.getObject` only invokes `parseJsonBody` on the bytes of
    // a 200 response. 5xx → `NetworkError` directly. Test removed
    // because the failure mode is no longer reachable.

    describe("clock-skew retry bound (Syncer.updateContent)", () => {
        afterEach(() => {
            reset();
        });

        test("rejects with NetworkError after the retry budget is exhausted", async () => {
            const mps3 = new MPS3({
                label: "skew",
                defaultBucket: `skew-${Math.random().toString(36).slice(2, 8)}`,
                minimizeListObjectsCalls: false,
                offlineStorage: false,
                adaptiveClock: true,
                parser: new DOMParser(),
                s3Config: { endpoint: MPS3.MEMORY_ENDPOINT },
            });

            // Each PUT result carries an ever-growing serverDate, so the
            // syncer's clockOffset adjustment never converges and every
            // retry sees a fresh out-of-window manifest. After
            // SYNCER_CLOCK_SKEW_MAX_RETRIES the loop must bail.
            let skewBoost = 60_000;
            const storage = mps3.storageFor(mps3.config.defaultBucket);
            const originalPut = storage.put.bind(storage);
            storage.put = async (key, body, opts) => {
                const result = await originalPut(key, body, opts);
                skewBoost += 60_000;
                return { ...result, serverDate: new Date(Date.now() + skewBoost) };
            };

            await expect(mps3.put("skew-key", "value")).rejects.toMatchObject({
                code: "NetworkError",
                message: expect.stringContaining(`${SYNCER_CLOCK_SKEW_MAX_RETRIES}`),
            });
        });
    });

    describe("session-ID collisions", () => {
        test("collision rate below 1% at N=100", () => {
            const N = 100;
            const ids = new Set<string>();
            let collisions = 0;
            for (let i = 0; i < N; i++) {
                const sid = uuid().substring(0, SESSION_ID_LENGTH);
                if (ids.has(sid)) collisions++;
                ids.add(sid);
            }
            expect(collisions / N).toBeLessThan(0.01);
        });
    });
});
